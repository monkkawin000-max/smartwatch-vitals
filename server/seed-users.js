// รันครั้งเดียว: node seed-users.js
// สร้างไฟล์ doctors.json และ it-staff.json (วางไฟล์นี้ไว้ในโฟลเดอร์ server/ เดียวกับ server.js)
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');

async function seed() {
  const doctors = [
    {
      doctorId: 'D001',
      name: 'พญ. ตัวอย่าง',
      active: true,
      passwordHash: await bcrypt.hash('doctor1234', 10),
      createdAt: new Date().toISOString(),
    },
  ];
  fs.writeFileSync(path.join(__dirname, 'doctors.json'), JSON.stringify(doctors, null, 2));

  const itStaff = [
    {
      username: 'itstaff1',
      name: 'เจ้าหน้าที่ IT ตัวอย่าง',
      passwordHash: await bcrypt.hash('itstaff1234', 10),
    },
  ];
  fs.writeFileSync(path.join(__dirname, 'it-staff.json'), JSON.stringify(itStaff, null, 2));

  console.log('สร้าง doctors.json และ it-staff.json เรียบร้อย');
  console.log('หมอ: รหัสแพทย์=D001 password=doctor1234');
  console.log('IT: username=itstaff1 password=itstaff1234');
  console.log('(คนไข้เก่าที่มีอยู่แล้ว 001/002 ยังไม่มีรหัสผ่าน — ใช้หน้า "ช่วยเหลือคนไข้ลืมรหัส" ของ IT ตั้งรหัสให้ได้)');
}

seed();
