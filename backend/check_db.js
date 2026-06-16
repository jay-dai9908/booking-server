import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  console.log("=== 資料庫健檢 ===");
  
  const allUsers = await prisma.user.findMany();
  console.log(`系統中總共有 ${allUsers.length} 位會員。`);
  
  const phoneUsers = allUsers.filter(u => u.phone && u.phone.trim() !== '');
  console.log(`其中有電話號碼的會員共有 ${phoneUsers.length} 位：`);
  
  for (const u of phoneUsers) {
    console.log(` - 姓名: ${u.name || '無'} | 電話: ${u.phone} | 註冊時間: ${u.created_at.toLocaleString()}`);
  }

  const allReservations = await prisma.reservation.findMany();
  console.log(`\n系統中總共有 ${allReservations.length} 筆訂單。`);
}

main().catch(e => console.error(e)).finally(() => prisma.$disconnect());
