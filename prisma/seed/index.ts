import { prisma } from './utils';
import { seedUsers } from './seed-users';
import { seedPlans } from './seed-plans';
import { seedRBAC } from './seed-rbac';

async function main() {
  console.log('Seeding rbac...');
   await seedRBAC();

  // console.log('Seeding users...');
  // await seedUsers();

  console.log('Seeding plans...');
  await seedPlans();

  console.log('✔ All seeders completed');
}

main()
  .catch((e) => {
    console.error('Seeder error:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
