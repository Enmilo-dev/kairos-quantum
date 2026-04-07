import { PrismaClient } from "../generated/prisma/client.js";
const prisma = new PrismaClient();

// export const databaseGen = (async()=> {
//     try {
//       const User = await prisma.user.findUnique({
//         where: {
//           telegramId: 412992797090n,
//         },
//         include: {alerts: true},
//       });

//       console.log(User);

//     } catch (error) {
//       console.error('Database connection error:', error);
//     } finally {
//       await prisma.$disconnect();
//     }
// });

prisma.$connect().then(() => {
    console.log('Database connected successfully.');
}).catch((error) => {
    console.error('Database connection error:', error);
});

export default prisma;
