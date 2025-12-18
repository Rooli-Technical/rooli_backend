import { prisma } from './utils';
import { seedPermissions } from './seed-permissions';
import { seedRoles } from './seed-roles';
import { seedUsers } from './seed-users';
import { seedPlans } from './seed-plans';

async function main() {
  console.log('Seeding permissions...');
  const permissionMap = await seedPermissions();

  console.log('Seeding roles...');
  await seedRoles(permissionMap);

  console.log('Seeding users...');
  await seedUsers();

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
