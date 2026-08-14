const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const VITALS_FILE = path.join(__dirname, 'data.json');
const PATIENTS_FILE = path.join(__dirname, 'patients.json');
const APPOINTMENTS_FILE = path.join(__dirname, 'appointments.json');

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// ---------- อ่าน/เขียนไฟล์ (แทนฐานข้อมูลจริง เพื่อความง่ายตอน prototype) ----------
function loadJson(file) {
  if (fs.existsSync(file)) {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf-8'));
    } catch (e) {
      console.error(`อ่านไฟล์ ${file} ไม่ได้ เริ่มข้อมูลใหม่:`, e.message);
      return [];
    }
  }
  return [];
}
function saveJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

let vitalRecords = loadJson(VITALS_FILE);
let patients = loadJson(PATIENTS_FILE);
let appointments = loadJson(APPOINTMENTS_FILE);

// ---------- ทะเบียนคนไข้ ----------

// GET /api/patients -> รายชื่อคนไข้ทั้งหมดที่ลงทะเบียนไว้
app.get('/api/patients', (req, res) => {
  res.json(patients);
});

// POST /api/patients -> เพิ่มคนไข้ใหม่
app.post('/api/patients', (req, res) => {
  const { patientId, name, age, note } = req.body;
  if (!patientId || !name) {
    return res.status(400).json({ error: 'กรุณาระบุ patientId และ name' });
  }
  if (patients.some((p) => p.patientId === patientId)) {
    return res.status(409).json({ error: 'มี patientId นี้ในระบบแล้ว' });
  }

  const patient = {
    patientId: String(patientId),
    name: String(name),
    age: age ? Number(age) : null,
    note: note || '',
    createdAt: new Date().toISOString(),
  };
  patients.push(patient);
  saveJson(PATIENTS_FILE, patients);

  console.log(`[PATIENT] เพิ่มคนไข้ใหม่: ${patient.patientId} — ${patient.name}`);
  res.status(201).json({ success: true, patient });
});

// DELETE /api/patients/:patientId -> ลบคนไข้ออกจากทะเบียน (ไม่ลบประวัติ vitals เก่า)
app.delete('/api/patients/:patientId', (req, res) => {
  const before = patients.length;
  patients = patients.filter((p) => p.patientId !== req.params.patientId);
  if (patients.length === before) {
    return res.status(404).json({ error: 'ไม่พบคนไข้รายนี้' });
  }
  saveJson(PATIENTS_FILE, patients);
  res.json({ success: true });
});

// ---------- Vital Signs ----------

// POST /api/vitals — endpoint ที่ "นาฬิกา" (หรือ Emulator) ยิงเข้ามาตอนซิงค์ข้อมูล
app.post('/api/vitals', (req, res) => {
  const { patientId, patientName, heartRate, systolic, diastolic, spo2, temperature } = req.body;

  if (!patientId) {
    return res.status(400).json({ error: 'กรุณาระบุ patientId' });
  }

  // ถ้าคนไข้รายนี้ยังไม่เคยลงทะเบียนไว้ ให้ลงทะเบียนอัตโนมัติจากชื่อที่ส่งมา (กันเคส sync ตรงโดยไม่ผ่านฟอร์มเพิ่มคนไข้)
  if (!patients.some((p) => p.patientId === patientId)) {
    patients.push({
      patientId: String(patientId),
      name: patientName || patientId,
      age: null,
      note: '',
      createdAt: new Date().toISOString(),
    });
    saveJson(PATIENTS_FILE, patients);
  }

  const record = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
    patientId: String(patientId),
    patientName: patientName || patientId,
    heartRate: Number(heartRate),
    systolic: Number(systolic),
    diastolic: Number(diastolic),
    spo2: Number(spo2),
    temperature: Number(temperature),
    timestamp: new Date().toISOString(),
  };

  vitalRecords.unshift(record);
  if (vitalRecords.length > 3000) vitalRecords = vitalRecords.slice(0, 3000); // กันไฟล์บวม

  saveJson(VITALS_FILE, vitalRecords);

  console.log(`[SYNC] รับค่าจากคนไข้ ${record.patientId} เวลา ${record.timestamp} | HR ${record.heartRate} BP ${record.systolic}/${record.diastolic} SpO2 ${record.spo2} Temp ${record.temperature}`);
  res.status(201).json({ success: true, record });
});

// GET /api/vitals -> ทุก record (ล่าสุดก่อน)
app.get('/api/vitals', (req, res) => {
  res.json(vitalRecords);
});

// GET /api/vitals/:patientId -> ประวัติของคนไข้รายเดียว
app.get('/api/vitals/:patientId', (req, res) => {
  const records = vitalRecords.filter((r) => r.patientId === req.params.patientId);
  res.json(records);
});

// GET /api/patients/latest -> คนไข้ทุกคนที่ลงทะเบียนไว้ พร้อมค่าล่าสุด (ถ้ามี)
app.get('/api/patients/latest', (req, res) => {
  const latestByPatient = {};
  for (const r of vitalRecords) {
    if (!latestByPatient[r.patientId]) latestByPatient[r.patientId] = r;
  }

  const merged = patients.map((p) => {
    const latest = latestByPatient[p.patientId] || null;
    return {
      patientId: p.patientId,
      patientName: p.name,
      age: p.age,
      note: p.note,
      hasData: !!latest,
      heartRate: latest ? latest.heartRate : null,
      systolic: latest ? latest.systolic : null,
      diastolic: latest ? latest.diastolic : null,
      spo2: latest ? latest.spo2 : null,
      temperature: latest ? latest.temperature : null,
      timestamp: latest ? latest.timestamp : null,
    };
  });

  res.json(merged);
});

// ---------- นัดหมาย (Appointments) ----------

// GET /api/appointments -> นัดหมายทั้งหมด เรียงตามวัน-เวลา
//   รองรับ query filter: ?date=YYYY-MM-DD หรือ ?patientId=xxx
app.get('/api/appointments', (req, res) => {
  let result = appointments;
  if (req.query.date) result = result.filter((a) => a.date === req.query.date);
  if (req.query.patientId) result = result.filter((a) => a.patientId === req.query.patientId);
  result = [...result].sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
  res.json(result);
});

// POST /api/appointments -> เพิ่มนัดหมายใหม่
app.post('/api/appointments', (req, res) => {
  const { patientId, date, time, note } = req.body;
  if (!patientId || !date || !time) {
    return res.status(400).json({ error: 'กรุณาระบุ patientId, date (YYYY-MM-DD) และ time (HH:MM)' });
  }
  const patient = patients.find((p) => p.patientId === patientId);
  if (!patient) {
    return res.status(404).json({ error: 'ไม่พบคนไข้รายนี้ในทะเบียน' });
  }

  const appt = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
    patientId,
    patientName: patient.name,
    date,   // เก็บเป็น "YYYY-MM-DD"
    time,   // เก็บเป็น "HH:MM"
    note: note || '',
    createdAt: new Date().toISOString(),
  };
  appointments.push(appt);
  saveJson(APPOINTMENTS_FILE, appointments);

  console.log(`[APPOINTMENT] นัดหมายใหม่: ${appt.patientId} (${appt.patientName}) วันที่ ${appt.date} เวลา ${appt.time}`);
  res.status(201).json({ success: true, appointment: appt });
});

// DELETE /api/appointments/:id -> ยกเลิกนัดหมาย
app.delete('/api/appointments/:id', (req, res) => {
  const before = appointments.length;
  appointments = appointments.filter((a) => a.id !== req.params.id);
  if (appointments.length === before) {
    return res.status(404).json({ error: 'ไม่พบนัดหมายนี้' });
  }
  saveJson(APPOINTMENTS_FILE, appointments);
  res.json({ success: true });
});

app.listen(PORT, () => {
  console.log(`\n✅ Server รันที่ http://localhost:${PORT}`);
  console.log(`   • หน้า Smartwatch Emulator (จำลองนาฬิกา): http://localhost:${PORT}/emulator.html`);
  console.log(`   • หน้า Dashboard หมอ (ดูค่าคนไข้):        http://localhost:${PORT}/dashboard.html`);
  console.log(`   • หน้า Calendar นัดหมาย:                  http://localhost:${PORT}/calendar.html\n`);
});
