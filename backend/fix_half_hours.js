import { PrismaClient, Prisma } from '@prisma/client';
import crypto from 'crypto';
import { allocateSeats } from './src/utils/SeatAllocator.js';

const prisma = new PrismaClient();

const fixData = [
  { name: '三角形西瓜', date: '2026-06-19', startHour: 13, numHours: 3, pax: 2 },
  { name: 'wen819', date: '2026-06-20', startHour: 13, numHours: 4, pax: 2 },
  { name: 'X', date: '2026-06-20', startHour: 13, numHours: 4, pax: 3 },
  { name: 'Chi', date: '2026-06-20', startHour: 17, numHours: 2, pax: 2 },
  { name: 'w.iiin', date: '2026-06-20', startHour: 19, numHours: 3, pax: 2 },
  { name: 'yinyouting', date: '2026-06-21', startHour: 15, numHours: 3, pax: 2 },
  { name: 'Y', date: '2026-06-22', startHour: 16, numHours: 2, pax: 1 },
  { name: 'lycoris', date: '2026-06-22', startHour: 17, numHours: 5, pax: 1 },
  { name: '真心相愛', date: '2026-06-24', startHour: 15, numHours: 4, pax: 3 },
  { name: '木YA易NG', date: '2026-06-25', startHour: 15, numHours: 2, pax: 2 }
];

async function main() {
  for (const data of fixData) {
    console.log("Fixing: " + data.name);
    try {
        await prisma.$transaction(async (tx) => {
            // 1. Find the user
            const targetUser = await tx.user.findFirst({ where: { name: data.name } });
            if (!targetUser) {
                console.log("User not found: " + data.name);
                return;
            }

            // 2. Delete old reservations for this user on this date
            const oldReservations = await tx.reservation.findMany({
                where: {
                    user_id: targetUser.id,
                    session: {
                        session_date: new Date(data.date + "T00:00:00.000Z")
                    }
                }
            });

            if (oldReservations.length > 0) {
                // Free up seats logic (actually just deleting them frees them up for the next steps)
                await tx.reservation.deleteMany({
                    where: { id: { in: oldReservations.map(r => r.id) } }
                });
            }

            // 3. Ensure new sessions exist
            const sessionIds = [];
            for (let i = 0; i < data.numHours; i++) {
                const s_start = String(data.startHour + i).padStart(2, '0') + ":00";
                const s_end = String(data.startHour + i + 1).padStart(2, '0') + ":00";
                
                let session = await tx.session.findUnique({
                    where: {
                        session_date_start_time: {
                            session_date: new Date(data.date + "T00:00:00.000Z"),
                            start_time: s_start
                        }
                    }
                });

                if (!session) {
                    session = await tx.session.create({
                        data: {
                            session_date: new Date(data.date + "T00:00:00.000Z"),
                            start_time: s_start,
                            end_time: s_end,
                            max_capacity: 16
                        }
                    });
                }
                sessionIds.push(session.id);
            }

            // 4. Re-allocate seats
            const sessions = await tx.session.findMany({
                where: { id: { in: sessionIds } },
                orderBy: { start_time: 'asc' }
            });
            
            const booking_ref = crypto.randomUUID();
            const sessionUpdates = []; 
            const newReservationsData = [];

            for (const session of sessions) {
                const currentReservations = await tx.reservation.findMany({
                    where: { session_id: session.id, status: 'confirmed' }
                });

                const newReservationMock = { id: 'NEW_RES', pax: data.pax, assigned_seats: null };
                const allocResult = allocateSeats(currentReservations, newReservationMock, true); 

                if (!allocResult.success) {
                    throw new Error("NO_SEATS for " + data.name + " at session " + session.id);
                }

                const mySeats = allocResult.updates.find(u => u.id === 'NEW_RES').assigned_seats;

                newReservationsData.push({
                    booking_ref,
                    session_id: session.id,
                    user_id: targetUser.id,
                    pax: data.pax,
                    status: 'confirmed',
                    assigned_seats: mySeats,
                    is_force_split: true
                });

                for (const update of allocResult.updates) {
                    if (update.id !== 'NEW_RES') {
                        sessionUpdates.push(
                            tx.reservation.update({
                                where: { id: update.id },
                                data: { assigned_seats: update.assigned_seats }
                            })
                        );
                    }
                }
            }

            if (sessionUpdates.length > 0) {
                await Promise.all(sessionUpdates);
            }

            await tx.reservation.createMany({
                data: newReservationsData
            });
        });
        console.log("-> Successfully fixed: " + data.name);
    } catch (err) {
        console.error("-> Failed to fix: " + data.name + " (" + err.message + ")");
    }
  }
}

main().catch(console.error).finally(() => prisma.$disconnect());
