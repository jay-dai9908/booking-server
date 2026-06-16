import { PrismaClient, Prisma } from '@prisma/client';
import crypto from 'crypto';
import { allocateSeats } from './src/utils/SeatAllocator.js';

const prisma = new PrismaClient();

const rawData = `
❤️6/19五 
憂鬱小貓 12～13 一小時 3
洪采鈴 13～15 兩小時 2
Aurelia 13~16 三小時 2
三角形西瓜 🍉13:30～15:30 兩小時2
JOYCE 15~17 兩小時 2
JIA 15~18 三小時 2
楊予涵 15～18 三小時 1
KK 15~18 三小時 2
Nataile 15~18 三小時 1
婕如 15～20 五小時 2
xu 16~17 一小時 2
恰 18～20 兩小時 1
榆 19～21 兩小時 2

❤️6/20六 
h12._.20x 11~12 一小時 3
魏于晴 13～15 兩小時 2
wen819 13:30~16:30 三小時 2
X 13:30~16:30 三個人 3
提拉米蘇 14～16 兩小時 1
吳榆婷 15～17 兩小時 2
恐龍 15～17 兩小時 2
Chi 17:30~18:30 一小時 2
陳曉恬 19～21 兩小時2
w.iiin 19:30~21:30 兩小時 2

❤️6/21日 
李佩軒 10～12 兩小時 4
羊 10～13 三小時 1
HLY 11~12 一小時 4
許芝曦 13～ 14 一小時2
yinyouting 3:30 兩小時 2

🤍6/22一
‼️(不限時15:00~23:00)
☢️☢️TOMOMI 不限時 2
☢️yiiik.07 不限時1
☢️☢️wowowowwwoo不限時 2
☢️☢️257_2547 不限時 2
已降智 15～17 兩小時 2
AN 15～18 三小時 1
Raccon 15~18 三小時 2
huiznn.7 15~18 三小時 2
Y 16:30~17:30 一小時 1
lycoris 17:30~21:30 四小時 1

🤍6/23二 
‼️(不限時15:00~23:00)
☢️☢️☢️愛 不限時 3
☢️🌟 不限時 1
☢️☢️Valeria 不限時 2
iltwwmw 15～18 三小時1
xizuuy 15~18 三小時 3
祖延 15～18三小時 2
155幼稚園小朋友 15～19 四小時 2

🤍6/24三
‼️(不限時15:00~23:00)
☢️榆皇大帝 不限時 1
☢️姵豬 不限時 1
搖搖七喜15~16一小時 2
詠豬 15～16 一小時 2
u5yu___ 15~16 一小時 3
Xin Yu 15~17 三小時 2
真心相愛 15:30～18:30 三小時 3
小欣 16～19 三小時 2
小Yen 16~17 一小時 2

🤍6/25四
‼️(不限時15:00~23:00)
☢️☢️田田 不限時2
木YA易NG 15:30～16:30 一小時 2
妍 15～18 三小時 2
涓☁️藍 15～17 兩小時 6
⭐️-_-15～18 三小時 3
YY 17～19 兩小時 2

🤍6/26五
‼️(不限時15:00~23:00)
☢️☢️YINZOE 不限時 2
徐曉琳 15～17 兩小時 2
少女時代有很嚴重 15～17 二小時 4
蘋果 15～17 兩小時 2
薇妮 15～18 三小時 2
PinPin 15~19 四小時 3
fish 17~18 一小時2
`;

async function main() {
  const lines = rawData.split('\n').map(l => l.trim()).filter(l => l);
  let currentDate = null;

  for (const line of lines) {
    if (line.includes('6/') && (line.includes('❤️') || line.includes('🤍'))) {
      const dayMatch = line.match(/6\/(\d+)/);
      if (dayMatch) {
        currentDate = "2026-06-" + dayMatch[1].padStart(2, '0');
        console.log("=== Date: " + currentDate + " ===");
      }
      continue;
    }

    if (line.includes('不限時15:00~23:00')) continue;

    let parsedName = "";
    let startHour = null;
    let numHours = null;
    let pax = null;

    let text = line.replace(/☢️/g, '').replace(/🌟/g, '').replace(/🍉/g, '').replace(/‼️/g, '').trim();

    if (text.includes('不限時')) {
      const parts = text.split('不限時');
      parsedName = parts[0].trim();
      pax = parseInt(parts[1].trim(), 10);
      startHour = 15;
      numHours = 8;
    } else {
      const match = text.match(/^(.*?) (\d{1,2}(?::\d{2})?[～~]\s*\d{1,2}(?::\d{2})?|3:30)\s*(?:[一二兩三四五六七八九十]個?人?小時)?\s*(\d+)$/);
      if (match) {
        parsedName = match[1].trim();
        pax = parseInt(match[3], 10);
        let timeStr = match[2].trim();
        
        if (timeStr === '3:30') {
            startHour = 15;
            numHours = 2;
        } else {
            const times = timeStr.split(/[～~]/);
            startHour = parseInt(times[0].split(':')[0], 10);
            if (times[0].includes('3:30')) startHour = 15;
            
            if (startHour < 10) startHour += 12;

            const endHour = parseInt(times[1].split(':')[0], 10);
            let adjustedEndHour = endHour;
            if (adjustedEndHour < 10 && adjustedEndHour !== 0) adjustedEndHour += 12;

            numHours = adjustedEndHour - startHour;
            if (numHours <= 0) numHours = 1;
        }
      } else {
          const parts = text.split(' ');
          pax = parseInt(parts[parts.length - 1], 10);
          if (isNaN(pax)) {
              console.log("Could not parse:", text);
              continue;
          }
          parsedName = parts[0];
          console.log("Guessed partially:", text);
          continue;
      }
    }

    // Manual overrides for weird formats
    if (text.includes("X 13:30~16:30 三個人 3")) {
      parsedName = "X"; startHour = 13; numHours = 3; pax = 3;
    } else if (text.includes("搖搖七喜15~16一小時 2")) {
      parsedName = "搖搖七喜"; startHour = 15; numHours = 1; pax = 2;
    } else if (text.includes("⭐️-_-15～18 三小時 3")) {
      parsedName = "⭐️-_-"; startHour = 15; numHours = 3; pax = 3;
    } else if (text === "不限時 1" && currentDate === "2026-06-23") {
      parsedName = "🌟"; startHour = 15; numHours = 8; pax = 1;
    }

    if (!parsedName || !startHour || !numHours || !pax) {
        console.log("Failed to parse properly:", line);
        continue;
    }

    console.log("Booking: " + parsedName + ", Date: " + currentDate + ", Start: " + startHour + ":00, Hours: " + numHours + ", Pax: " + pax);

    const sessionIds = [];
    for (let i = 0; i < numHours; i++) {
        const s_start = String(startHour + i).padStart(2, '0') + ":00";
        const s_end = String(startHour + i + 1).padStart(2, '0') + ":00";
        
        let session = await prisma.session.findUnique({
            where: {
                session_date_start_time: {
                    session_date: new Date(currentDate + "T00:00:00.000Z"),
                    start_time: s_start
                }
            }
        });

        if (!session) {
            session = await prisma.session.create({
                data: {
                    session_date: new Date(currentDate + "T00:00:00.000Z"),
                    start_time: s_start,
                    end_time: s_end,
                    max_capacity: 16
                }
            });
        }
        sessionIds.push(session.id);
    }

    try {
        await prisma.$transaction(async (tx) => {
            let targetUser = await tx.user.findFirst({ where: { name: parsedName } });
            if (!targetUser) {
                targetUser = await tx.user.create({
                    data: {
                        line_user_id: "manual_import_" + crypto.randomUUID(),
                        name: parsedName
                    }
                });
            }

            const sessions = await tx.session.findMany({
                where: { id: { in: sessionIds } }
            });
            
            const booking_ref = crypto.randomUUID();
            const sessionUpdates = []; 
            const newReservationsData = [];

            for (const session of sessions) {
                const currentReservations = await tx.reservation.findMany({
                    where: { session_id: session.id, status: 'confirmed' }
                });

                const newReservationMock = { id: 'NEW_RES', pax: pax, assigned_seats: null };
                const allocResult = allocateSeats(currentReservations, newReservationMock, true); 

                if (!allocResult.success) {
                    throw new Error("NO_SEATS for " + parsedName + " at session " + session.id);
                }

                const mySeats = allocResult.updates.find(u => u.id === 'NEW_RES').assigned_seats;

                newReservationsData.push({
                    booking_ref,
                    session_id: session.id,
                    user_id: targetUser.id,
                    pax,
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
        console.log("-> Success: " + parsedName);
    } catch (err) {
        console.error("-> Failed: " + parsedName + " (" + err.message + ")");
    }
  }
}

main().catch(console.error).finally(() => prisma.$disconnect());
