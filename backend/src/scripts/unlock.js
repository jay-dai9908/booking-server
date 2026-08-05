import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function unlockSystem() {
  try {
    console.log('Initiating system unlock sequence...');
    
    // 1. Disable lockdown mode
    await prisma.globalSetting.upsert({
      where: { id: 1 },
      update: { is_lockdown_mode: false },
      create: { id: 1, is_lockdown_mode: false }
    });
    console.log('✓ Lockdown mode disabled.');

    // 2. Clear BannedIP table
    const deleted = await prisma.bannedIP.deleteMany();
    console.log(`✓ Cleared ${deleted.count} banned IPs from database.`);

    console.log('\n=========================================');
    console.log('SYSTEM UNLOCKED SUCCESSFULLY');
    console.log('Please restart the backend server using pm2 to clear the memory cache:');
    console.log('  pm2 restart all');
    console.log('=========================================');
    
  } catch (error) {
    console.error('Failed to unlock system:', error);
  } finally {
    await prisma.$disconnect();
  }
}

unlockSystem();
