import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { importSrv } from "../scripts/import-srv";
const db = new PrismaClient();
const categories = [
  "Fan Boxes",
  "Concealed Boxes",
  "Modular Boxes",
  "MCB Distribution Boxes",
  "Bus Bar Distribution Boxes",
  "Changeover Switches",
  "Automatic Changeovers",
  "KitKat Fuses",
  "Junction Boxes",
  "Main Switches",
  "LED Flood Lights",
  "LED Downlighters",
  "Outdoor Lights",
  "Exhaust Fans",
  "Room Heaters",
  "Ventilation Fans",
  "Door Bells",
  "Domestic Water Pump Starters",
  "PVC Pipes and Accessories",
  "Electrical Accessories",
];
async function seed() {
  for (const name of categories) {
    const slug = name.toLowerCase().replaceAll(" ", "-");
    await db.category.upsert({
      where: { slug },
      create: { name, slug },
      update: {},
    });
  }
  await db.siteSettings.upsert({
    where: { id: "main" },
    create: {
      id: "main",
      content: {
        brand: "SRV Electricals",
        heroTitle: "Powering every connection.",
        heroDescription:
          "Electrical essentials for homes, worksites and everything you build.",
        announcement:
          "Planning a project? Ask about bulk supply and dealer enquiries.",
        businessEmail: "",
        whatsappNumber: "",
        reviews: [],
        brands: [],
        certifications: [],
      },
    },
    update: {},
  });
  await importSrv(db);
}
seed()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
