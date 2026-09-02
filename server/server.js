const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const session = require('express-session');

const app = express();
const PORT = process.env.PORT || 3000;

// สำคัญมากสำหรับ deploy บน Render/Heroku: บอก Express ว่าอยู่หลัง reverse proxy
// ถ้าไม่มีบรรทัดนี้ session cookie (secure: true) จะทำงานผิดพลาด login แล้ว "หลุด" ทันที
app.set('trust proxy', 1);
const VITALS_FILE = path.join(__dirname, 'data.json');
const PATIENTS_FILE = path.join(__dirname, 'patients.json');
const APPOINTMENTS_FILE = path.join(__dirname, 'appointments.json');
const DOCTORS_FILE = path.join(__dirname, 'doctors.json');
const IT_STAFF_FILE = path.join(__dirname, 'it-staff.json');
const DEVICES_FILE = path.join(__dirname, 'devices.json'); // ← ใหม่: เก็บการผูก Smart Watch กับคนไข้

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());

app.use(
  session({
    secret: process.env.SESSION_SECRET || 'smartwatch-vitals-dev-secret-เปลี่ยนก่อน-deploy',
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      maxAge: 1000 * 60 * 60 * 8,
      secure: process.env.NODE_ENV === 'production',
    },
  })
);

app.use(express.static(path.join(__dirname, '..', 'public')));

// ---------- อ่าน/เขียนไฟล์ ----------
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
let doctors = loadJson(DOCTORS_FILE);
let itStaff = loadJson(IT_STAFF_FILE);
let devices = loadJson(DEVICES_FILE); // ← ใหม่: [{ deviceId, patientId, pairedAt }]

// ---------- Migration: เติม field ที่ขาดให้ข้อมูลเก่า (เผื่อไฟล์เก่ายังไม่มี active/passwordHash) ----------
let patientsMigrated = false;
for (const p of patients) {
  if (p.active === undefined) { p.active = true; patientsMigrated = true; }
  if (p.passwordHash === undefined) { p.passwordHash = null; patientsMigrated = true; }
}
if (patientsMigrated) saveJson(PATIENTS_FILE, patients);

// ---------- Middleware ป้องกัน route ตาม role ----------
function requireRole(...allowedRoles) {
  return (req, res, next) => {
    if (!req.session || !req.session.user) {
      return res.status(401).json({ error: 'กรุณาเข้าสู่ระบบก่อน' });
    }
    if (!allowedRoles.includes(req.session.user.role)) {
      return res.status(403).json({ error: 'ไม่มีสิทธิ์เข้าถึงส่วนนี้' });
    }
    next();
  };
}

// ---------- Helper: สร้าง ID แบบเดินหน้าเรื่อยๆ ไม่รีไซเคิล ----------
// นับจาก ID สูงสุดที่เคยมีอยู่ในระบบ (รวมคนที่ปิดบัญชีไปแล้วด้วย) แล้ว +1 เสมอ
function nextPatientId() {
  let max = 0;
  for (const p of patients) {
    const n = parseInt(p.patientId, 10);
    if (!isNaN(n) && n > max) max = n;
  }
  return String(max + 1).padStart(3, '0'); // "001", "002", ...
}
function nextDoctorId() {
  let max = 0;
  for (const d of doctors) {
    const n = parseInt(d.doctorId.replace('D', ''), 10);
    if (!isNaN(n) && n > max) max = n;
  }
  return 'D' + String(max + 1).padStart(3, '0'); // "D001", "D002", ...
}

// ================== Login / Logout ==================

// POST /api/auth/login/patient -> login ด้วย patientId + password
app.post('/api/auth/login/patient', async (req, res) => {
  const { patientId, password } = req.body;
  if (!patientId || !password) {
    return res.status(400).json({ error: 'กรุณากรอกรหัสคนไข้และรหัสผ่าน' });
  }
  const patient = patients.find((p) => p.patientId === String(patientId));
  if (!patient || !patient.passwordHash) {
    return res.status(401).json({ error: 'ไม่พบรหัสคนไข้นี้ หรือยังไม่ได้ตั้งรหัสผ่าน' });
  }
  if (!patient.active) {
    return res.status(403).json({ error: 'บัญชีนี้ถูกปิดใช้งาน กรุณาติดต่อเจ้าหน้าที่ IT' });
  }
  const isValid = await bcrypt.compare(password, patient.passwordHash);
  if (!isValid) {
    return res.status(401).json({ error: 'รหัสผ่านไม่ถูกต้อง' });
  }
  req.session.user = { patientId: patient.patientId, name: patient.name, role: 'patient' };
  res.json({ success: true, user: req.session.user });
});

// POST /api/auth/login/doctor -> login ด้วย doctorId (เช่น D001) + password
app.post('/api/auth/login/doctor', async (req, res) => {
  const { doctorId, password } = req.body;
  if (!doctorId || !password) {
    return res.status(400).json({ error: 'กรุณากรอกรหัสแพทย์และรหัสผ่าน' });
  }
  const doctor = doctors.find((d) => d.doctorId === String(doctorId).toUpperCase());
  if (!doctor) {
    return res.status(401).json({ error: 'ไม่พบรหัสแพทย์นี้' });
  }
  if (!doctor.active) {
    return res.status(403).json({ error: 'บัญชีนี้ถูกปิดใช้งาน กรุณาติดต่อเจ้าหน้าที่ IT' });
  }
  const isValid = await bcrypt.compare(password, doctor.passwordHash);
  if (!isValid) {
    return res.status(401).json({ error: 'รหัสผ่านไม่ถูกต้อง' });
  }
  req.session.user = { doctorId: doctor.doctorId, name: doctor.name, role: 'doctor' };
  res.json({ success: true, user: req.session.user });
});

// POST /api/auth/login/it -> login ด้วย username + password (ยังคงเป็น manual/seed เท่านั้น)
app.post('/api/auth/login/it', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'กรุณากรอก username และรหัสผ่าน' });
  }
  const staff = itStaff.find((s) => s.username === username);
  if (!staff) {
    return res.status(401).json({ error: 'ไม่พบผู้ใช้นี้' });
  }
  const isValid = await bcrypt.compare(password, staff.passwordHash);
  if (!isValid) {
    return res.status(401).json({ error: 'รหัสผ่านไม่ถูกต้อง' });
  }
  req.session.user = { username: staff.username, name: staff.name, role: 'it' };
  res.json({ success: true, user: req.session.user });
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) return res.status(500).json({ error: 'ออกจากระบบไม่สำเร็จ' });
    res.clearCookie('connect.sid');
    res.json({ success: true });
  });
});

app.get('/api/auth/me', (req, res) => {
  if (req.session && req.session.user) {
    return res.json({ loggedIn: true, user: req.session.user });
  }
  res.json({ loggedIn: false });
});

// POST /api/auth/set-password -> IT ตั้ง/รีเซ็ตรหัสผ่านให้คนไข้หรือหมอ
// body: { role: 'patient'|'doctor', id: patientId หรือ doctorId, newPassword }
app.post('/api/auth/set-password', requireRole('it'), async (req, res) => {
  const { role, id, newPassword } = req.body;
  if (!role || !id || !newPassword) {
    return res.status(400).json({ error: 'กรุณาระบุ role, id และรหัสผ่านใหม่' });
  }
  const hash = await bcrypt.hash(newPassword, 10);

  if (role === 'patient') {
    const patient = patients.find((p) => p.patientId === String(id));
    if (!patient) return res.status(404).json({ error: 'ไม่พบคนไข้รายนี้' });
    patient.passwordHash = hash;
    saveJson(PATIENTS_FILE, patients);
    return res.json({ success: true });
  }
  if (role === 'doctor') {
    const doctor = doctors.find((d) => d.doctorId === String(id));
    if (!doctor) return res.status(404).json({ error: 'ไม่พบแพทย์รายนี้' });
    doctor.passwordHash = hash;
    saveJson(DOCTORS_FILE, doctors);
    return res.json({ success: true });
  }
  return res.status(400).json({ error: 'role ต้องเป็น patient หรือ doctor' });
});

// ================== ทะเบียนคนไข้ ==================

// GET /api/patients -> คนไข้ทั้งหมด (รวมที่ปิดบัญชีไปแล้ว) ไม่ส่ง passwordHash กลับ
app.get('/api/patients', (req, res) => {
  res.json(patients.map((p) => ({ ...p, passwordHash: undefined })));
});

// POST /api/patients -> เพิ่มคนไข้ใหม่ (ระบบออก patientId ให้อัตโนมัติ ไม่รับจากผู้ใช้)
app.post('/api/patients', async (req, res) => {
  const { name, age, note, password } = req.body;
  if (!name) {
    return res.status(400).json({ error: 'กรุณาระบุชื่อคนไข้' });
  }
  const patientId = nextPatientId();
  const patient = {
    patientId,
    name: String(name),
    age: age ? Number(age) : null,
    note: note || '',
    active: true,
    passwordHash: password ? await bcrypt.hash(password, 10) : null,
    createdAt: new Date().toISOString(),
  };
  patients.push(patient);
  saveJson(PATIENTS_FILE, patients);

  console.log(`[PATIENT] เพิ่มคนไข้ใหม่: ${patient.patientId} — ${patient.name}`);
  res.status(201).json({ success: true, patient: { ...patient, passwordHash: undefined } });
});

// PATCH /api/patients/:patientId/deactivate -> ปิดบัญชี (soft-delete) แทนการลบจริง
app.patch('/api/patients/:patientId/deactivate', requireRole('it'), (req, res) => {
  const patient = patients.find((p) => p.patientId === req.params.patientId);
  if (!patient) return res.status(404).json({ error: 'ไม่พบคนไข้รายนี้' });
  patient.active = false;
  saveJson(PATIENTS_FILE, patients);
  res.json({ success: true });
});

// PATCH /api/patients/:patientId/reactivate -> เปิดบัญชีคืน (ใช้ patientId เดิม)
app.patch('/api/patients/:patientId/reactivate', requireRole('it'), (req, res) => {
  const patient = patients.find((p) => p.patientId === req.params.patientId);
  if (!patient) return res.status(404).json({ error: 'ไม่พบคนไข้รายนี้' });
  patient.active = true;
  saveJson(PATIENTS_FILE, patients);
  res.json({ success: true });
});

// DELETE /api/patients/:patientId -> ลบออกจากทะเบียนจริง (เก็บไว้เผื่อกรณีฉุกเฉิน ปกติไม่ใช้จากหน้า IT แล้ว ใช้ deactivate แทน)
app.delete('/api/patients/:patientId', (req, res) => {
  const before = patients.length;
  patients = patients.filter((p) => p.patientId !== req.params.patientId);
  if (patients.length === before) {
    return res.status(404).json({ error: 'ไม่พบคนไข้รายนี้' });
  }
  saveJson(PATIENTS_FILE, patients);
  res.json({ success: true });
});

// ================== ทะเบียนแพทย์ (ใหม่ทั้งหมด) ==================

// GET /api/doctors -> แพทย์ทั้งหมด (รวมที่ปิดบัญชีไปแล้ว) ไม่ส่ง passwordHash กลับ
app.get('/api/doctors', (req, res) => {
  res.json(doctors.map((d) => ({ ...d, passwordHash: undefined })));
});

// POST /api/doctors -> เพิ่มแพทย์ใหม่ (ระบบออก doctorId ให้อัตโนมัติ เช่น D001)
app.post('/api/doctors', requireRole('it'), async (req, res) => {
  const { name, password } = req.body;
  if (!name || !password) {
    return res.status(400).json({ error: 'กรุณาระบุชื่อแพทย์และรหัสผ่านเริ่มต้น' });
  }
  const doctorId = nextDoctorId();
  const doctor = {
    doctorId,
    name: String(name),
    active: true,
    passwordHash: await bcrypt.hash(password, 10),
    createdAt: new Date().toISOString(),
  };
  doctors.push(doctor);
  saveJson(DOCTORS_FILE, doctors);

  console.log(`[DOCTOR] เพิ่มแพทย์ใหม่: ${doctor.doctorId} — ${doctor.name}`);
  res.status(201).json({ success: true, doctor: { ...doctor, passwordHash: undefined } });
});

// PATCH /api/doctors/:doctorId/deactivate
app.patch('/api/doctors/:doctorId/deactivate', requireRole('it'), (req, res) => {
  const doctor = doctors.find((d) => d.doctorId === req.params.doctorId);
  if (!doctor) return res.status(404).json({ error: 'ไม่พบแพทย์รายนี้' });
  doctor.active = false;
  saveJson(DOCTORS_FILE, doctors);
  res.json({ success: true });
});

// PATCH /api/doctors/:doctorId/reactivate
app.patch('/api/doctors/:doctorId/reactivate', requireRole('it'), (req, res) => {
  const doctor = doctors.find((d) => d.doctorId === req.params.doctorId);
  if (!doctor) return res.status(404).json({ error: 'ไม่พบแพทย์รายนี้' });
  doctor.active = true;
  saveJson(DOCTORS_FILE, doctors);
  res.json({ success: true });
});

// ================== Device Pairing (ใหม่ทั้งหมด) ==================
// mock: Device ID เป็นข้อความที่พิมพ์มือ ยังไม่ได้เชื่อม Bluetooth จริง

// GET /api/devices -> อุปกรณ์ที่ผูกอยู่ทั้งหมด พร้อมชื่อคนไข้
app.get('/api/devices', (req, res) => {
  const result = devices.map((dv) => {
    const patient = patients.find((p) => p.patientId === dv.patientId);
    return { ...dv, patientName: patient ? patient.name : dv.patientId };
  });
  res.json(result);
});

// POST /api/devices/pair -> ผูกอุปกรณ์กับคนไข้ (body: { patientId, deviceId })
app.post('/api/devices/pair', requireRole('it'), (req, res) => {
  const { patientId, deviceId } = req.body;
  if (!patientId || !deviceId) {
    return res.status(400).json({ error: 'กรุณาระบุคนไข้และหมายเลขอุปกรณ์' });
  }
  const patient = patients.find((p) => p.patientId === String(patientId));
  if (!patient) return res.status(404).json({ error: 'ไม่พบคนไข้รายนี้' });
  if (!patient.active) return res.status(403).json({ error: 'คนไข้รายนี้ปิดบัญชีอยู่ ไม่สามารถผูกอุปกรณ์ได้' });

  // 1 คนไข้ผูกได้แค่ 1 เครื่อง — ถ้ามีอยู่แล้วต้องยกเลิกก่อน
  if (devices.some((dv) => dv.patientId === String(patientId))) {
    return res.status(409).json({ error: 'คนไข้รายนี้มีอุปกรณ์ผูกอยู่แล้ว กรุณายกเลิกอุปกรณ์เดิมก่อน' });
  }
  // เครื่องนี้ต้องไม่ถูกผูกกับคนอื่นอยู่แล้ว
  if (devices.some((dv) => dv.deviceId === String(deviceId))) {
    return res.status(409).json({ error: 'หมายเลขอุปกรณ์นี้ถูกผูกกับคนไข้รายอื่นอยู่แล้ว' });
  }

  const record = { deviceId: String(deviceId), patientId: String(patientId), pairedAt: new Date().toISOString() };
  devices.push(record);
  saveJson(DEVICES_FILE, devices);

  console.log(`[DEVICE] ผูกอุปกรณ์ ${record.deviceId} กับคนไข้ ${record.patientId}`);
  res.status(201).json({ success: true, device: record });
});

// DELETE /api/devices/:patientId -> ยกเลิกการผูกอุปกรณ์ของคนไข้รายนี้
app.delete('/api/devices/:patientId', requireRole('it'), (req, res) => {
  const before = devices.length;
  devices = devices.filter((dv) => dv.patientId !== req.params.patientId);
  if (devices.length === before) {
    return res.status(404).json({ error: 'คนไข้รายนี้ไม่มีอุปกรณ์ผูกอยู่' });
  }
  saveJson(DEVICES_FILE, devices);
  res.json({ success: true });
});

// ---------- Vital Signs ----------

app.post('/api/vitals', (req, res) => {
  const { patientId, patientName, heartRate, systolic, diastolic, spo2, temperature } = req.body;

  if (!patientId) {
    return res.status(400).json({ error: 'กรุณาระบุ patientId' });
  }

  if (!patients.some((p) => p.patientId === patientId)) {
    patients.push({
      patientId: String(patientId),
      name: patientName || patientId,
      age: null,
      note: '',
      active: true,
      passwordHash: null,
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
  if (vitalRecords.length > 3000) vitalRecords = vitalRecords.slice(0, 3000);

  saveJson(VITALS_FILE, vitalRecords);

  console.log(`[SYNC] รับค่าจากคนไข้ ${record.patientId} เวลา ${record.timestamp} | HR ${record.heartRate} BP ${record.systolic}/${record.diastolic} SpO2 ${record.spo2} Temp ${record.temperature}`);
  res.status(201).json({ success: true, record });
});

app.get('/api/vitals', (req, res) => {
  res.json(vitalRecords);
});

app.get('/api/vitals/:patientId', (req, res) => {
  const records = vitalRecords.filter((r) => r.patientId === req.params.patientId);
  res.json(records);
});

// GET /api/vitals/stats/:patientId?from=YYYY-MM-DD&to=YYYY-MM-DD
// สรุปค่าเฉลี่ย Vital Signs ในช่วงวันที่ที่เลือก (ใช้สำหรับหน้ารายงานของหมอ)
app.get('/api/vitals/stats/:patientId', (req, res) => {
  const { from, to } = req.query;
  if (!from || !to) {
    return res.status(400).json({ error: 'กรุณาระบุ from และ to (YYYY-MM-DD)' });
  }

  const records = vitalRecords.filter((r) => {
    if (r.patientId !== req.params.patientId) return false;
    const d = r.timestamp.slice(0, 10); // "YYYY-MM-DD"
    return d >= from && d <= to;
  });

  if (records.length === 0) {
    return res.json({ hasData: false, count: 0, summary: null, daily: [] });
  }

  const avg = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;
  const summary = {
    avgHeartRate: Math.round(avg(records.map((r) => r.heartRate))),
    avgSystolic: Math.round(avg(records.map((r) => r.systolic))),
    avgDiastolic: Math.round(avg(records.map((r) => r.diastolic))),
    avgSpo2: Math.round(avg(records.map((r) => r.spo2))),
    avgTemperature: Math.round(avg(records.map((r) => r.temperature)) * 10) / 10,
  };

  // จัดกลุ่มตามวัน แล้วเฉลี่ยของแต่ละวัน เรียงจากเก่าไปใหม่
  const byDate = {};
  for (const r of records) {
    const d = r.timestamp.slice(0, 10);
    if (!byDate[d]) byDate[d] = [];
    byDate[d].push(r);
  }
  const daily = Object.keys(byDate).sort().map((date) => {
    const recs = byDate[date];
    return {
      date,
      avgHeartRate: Math.round(avg(recs.map((r) => r.heartRate))),
      avgSystolic: Math.round(avg(recs.map((r) => r.systolic))),
      avgDiastolic: Math.round(avg(recs.map((r) => r.diastolic))),
      avgSpo2: Math.round(avg(recs.map((r) => r.spo2))),
      avgTemperature: Math.round(avg(recs.map((r) => r.temperature)) * 10) / 10,
    };
  });

  res.json({ hasData: true, count: records.length, summary, daily });
});

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

app.get('/api/appointments', (req, res) => {
  let result = appointments;
  if (req.query.date) result = result.filter((a) => a.date === req.query.date);
  if (req.query.patientId) result = result.filter((a) => a.patientId === req.query.patientId);
  result = [...result].sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
  res.json(result);
});

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
    date,
    time,
    note: note || '',
    createdAt: new Date().toISOString(),
  };
  appointments.push(appt);
  saveJson(APPOINTMENTS_FILE, appointments);

  console.log(`[APPOINTMENT] นัดหมายใหม่: ${appt.patientId} (${appt.patientName}) วันที่ ${appt.date} เวลา ${appt.time}`);
  res.status(201).json({ success: true, appointment: appt });
});

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
