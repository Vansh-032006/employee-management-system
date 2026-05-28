'use strict';
// ======================================================================
//  EMS - Enterprise HR Platform
//  Connectivity: localhost\SQLEXPRESS | EMS_DB | sa / sa123 [UNCHANGED]
// ======================================================================
const express = require('express');
const sql     = require('mssql');
const path    = require('path');
const app     = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname)));

const config = {
  server: 'localhost\\SQLEXPRESS',
  database: 'EMS_DB',
  user: 'sa',
  password: 'sa123',
  options: { trustServerCertificate: true, encrypt: false }
};

const sessions = {};
function makeToken() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36) + Math.random().toString(36).slice(2);
}
function getSession(req) {
  const auth = req.headers['authorization'] || '';
  const tok  = auth.replace('Bearer ','').trim() || req.query._tok || '';
  return sessions[tok] || null;
}
function requireAdmin(req, res, next) {
  const s = getSession(req);
  if (!s) return res.status(401).json({ error: 'Not authenticated' });
  if (s.role === 'employee') return res.status(403).json({ error: 'Admin only' });
  next();
}
function requireAuth(req, res, next) {
  const s = getSession(req);
  if (!s) return res.status(401).json({ error: 'Not authenticated' });
  req.session = s;
  next();
}

async function getPool() { return sql.connect(config); }
async function q(qs, params = {}) {
  const pool = await getPool();
  const r = pool.request();
  Object.entries(params).forEach(([k, v]) => r.input(k, v));
  return r.query(qs);
}

async function notify(empId, msg, type='info') {
  try { await q(`INSERT INTO Notifications(EmpID,Message,Type,IsRead,CreatedAt) VALUES(@e,@m,@t,0,GETDATE())`, { e:empId, m:msg, t:type }); } catch(_) {}
}
async function audit(actor, action, target, detail) {
  try { await q(`INSERT INTO AuditLog(Actor,Action,Target,Detail,CreatedAt) VALUES(@a,@b,@c,@d,GETDATE())`, { a:actor, b:action, c:target, d:detail }); } catch(_) {}
}
function actor(req) { const s = getSession(req); return s?.username || s?.empId || 'system'; }

async function calcSalary(empId, month, year) {
  const pool = await getPool();
  const sc = await pool.request().input('e',empId).query(`SELECT TOP 1 * FROM SalaryComponents WHERE EmpID=@e`);
  const comp = sc.recordset[0];
  if (!comp) return null;
  const basic  = parseFloat(comp.BasicSalary||0);
  const hraPct = parseFloat(comp.HRA_Pct||20);
  const daPct  = parseFloat(comp.DA_Pct||10);
  const pfPct  = parseFloat(comp.PF_Pct||12);
  const taxPct = parseFloat(comp.Tax_Pct||10);
  const att = await pool.request().input('e',empId).input('m',month).input('y',year)
    .query(`SELECT COUNT(CASE WHEN Status IN ('Present','Late') THEN 1 END) AS Present,
      COUNT(CASE WHEN Status='Absent' THEN 1 END) AS Absent,
      COUNT(CASE WHEN Status='Late' THEN 1 END) AS Late,
      COUNT(CASE WHEN Status='Half-day' THEN 1 END) AS HalfDay,
      ISNULL(SUM(OvertimeHours),0) AS OT
    FROM Attendance WHERE EmpID=@e AND MONTH(CheckIn)=@m AND YEAR(CheckIn)=@y`);
  const a = att.recordset[0];
  const present=parseInt(a.Present)||0, absent=parseInt(a.Absent)||0;
  const late=parseInt(a.Late)||0, halfDay=parseInt(a.HalfDay)||0, ot=parseFloat(a.OT)||0;
  const lv = await pool.request().input('e',empId).input('m',month).input('y',year)
    .query(`SELECT ISNULL(SUM(Days),0) AS UL FROM Leaves WHERE EmpID=@e AND Status='Approved' AND LeaveType='Unpaid' AND MONTH(FromDate)=@m AND YEAR(FromDate)=@y`);
  const unpaid = parseInt(lv.recordset[0].UL)||0;
  const bn = await pool.request().input('e',empId).input('m',month).input('y',year)
    .query(`SELECT ISNULL(SUM(Amount),0) AS B FROM BonusRequests WHERE EmpID=@e AND Status='Approved' AND MONTH(RequestDate)=@m AND YEAR(RequestDate)=@y`);
  const bonus = parseFloat(bn.recordset[0].B)||0;
  const workDays=26, perDay=basic/workDays;
  const hra=basic*hraPct/100, da=basic*daPct/100, gross=basic+hra+da+bonus;
  const latePen=late*perDay*0.1, halfDeduct=halfDay*perDay*0.5;
  const absentDed=Math.max(0,absent-unpaid)*perDay, unpaidDed=unpaid*perDay;
  const otPay=ot*(perDay/8)*1.5, pf=basic*pfPct/100, tax=gross*taxPct/100;
  const totalDed=pf+tax+absentDed+unpaidDed+latePen+halfDeduct;
  const net=Math.max(0,gross+otPay-totalDed);
  return { basic,hra,da,bonus,gross,otPay,pf,tax,absentDed,unpaidDed,latePen,halfDeduct,totalDed,
    net:Math.round(net),present,absent,late,halfDay,ot,unpaid,hraPct,daPct,pfPct,taxPct,workDays };
}

async function autoRecalc(empId, month, year) {
  try {
    const ex = await q(`SELECT PayrollID FROM Payroll WHERE EmpID=@e AND Month=@m AND Year=@y`, { e:empId,m:month,y:year });
    if (!ex.recordset.length) return;
    const s = await calcSalary(empId, month, year);
    if (!s) return;
    await q(`UPDATE Payroll SET NetSalary=@n,GrossSalary=@g,HRA=@h,DA=@d,PF=@pf,Tax=@tx,LeaveDeduct=@ld,OvertimePay=@ot,TotalDeduct=@td,Bonus=@b,PresentDays=@pd,GeneratedOn=GETDATE() WHERE EmpID=@e AND Month=@m AND Year=@y`,
      { n:s.net,g:Math.round(s.gross),h:Math.round(s.hra),d:Math.round(s.da),pf:Math.round(s.pf),tx:Math.round(s.tax),ld:Math.round(s.absentDed+s.unpaidDed),ot:Math.round(s.otPay),td:Math.round(s.totalDed),b:Math.round(s.bonus),pd:s.present,e:empId,m:month,y:year });
  } catch(_) {}
}

function startScheduler() {
  setInterval(async () => {
    const now = new Date();
    if (now.getHours() !== 0 || now.getMinutes() > 10) return;
    try {
      const pool = await getPool();
      const today = now.toISOString().slice(0,10);
      const emps = await pool.request().query(`SELECT EmpID FROM Employees WHERE Status='Active'`);
      for (const emp of emps.recordset) {
        const ex = await pool.request().input('e',emp.EmpID).input('d',today)
          .query(`SELECT AttID FROM Attendance WHERE EmpID=@e AND CAST(CheckIn AS DATE)=@d`);
        if (!ex.recordset.length)
          await pool.request().input('e',emp.EmpID).input('d',today)
            .query(`INSERT INTO Attendance(EmpID,CheckIn,CheckOut,Status,OvertimeHours) VALUES(@e,@d,@d,'Absent',0)`);
      }
    } catch(err) { console.error('[Scheduler]', err.message); }
  }, 60000);
}

// ======================================================================
//  DB SETUP
// ======================================================================
async function setupDB() {
  try {
    const tmp = await sql.connect({ ...config, database: 'master' });
    await tmp.request().query(`IF NOT EXISTS (SELECT name FROM sys.databases WHERE name='EMS_DB') CREATE DATABASE EMS_DB`);
    await tmp.close();
    const pool = await getPool();

    await pool.request().query(`IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='Users' AND xtype='U') CREATE TABLE Users (UserID INT IDENTITY PRIMARY KEY, Username NVARCHAR(50) UNIQUE NOT NULL, Password NVARCHAR(100) NOT NULL, Role NVARCHAR(10) NOT NULL DEFAULT 'user', CreatedAt DATETIME DEFAULT GETDATE())`);
    await pool.request().query(`IF NOT EXISTS (SELECT * FROM Users WHERE Username='admin') INSERT INTO Users(Username,Password,Role) VALUES('admin','admin123','admin'); IF NOT EXISTS (SELECT * FROM Users WHERE Username='user') INSERT INTO Users(Username,Password,Role) VALUES('user','user123','user')`);
    await pool.request().query(`IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='Departments' AND xtype='U') CREATE TABLE Departments (DeptID INT IDENTITY PRIMARY KEY, DeptName NVARCHAR(50) UNIQUE NOT NULL, DeptCode NVARCHAR(10) UNIQUE NOT NULL, HeadCount INT DEFAULT 0, CreatedAt DATETIME DEFAULT GETDATE())`);
    await pool.request().query(`IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='Roles' AND xtype='U') CREATE TABLE Roles (RoleID INT IDENTITY PRIMARY KEY, RoleName NVARCHAR(50) UNIQUE NOT NULL, BaseSalary INT NOT NULL, DeptID INT, FOREIGN KEY (DeptID) REFERENCES Departments(DeptID))`);
    await pool.request().query(`IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='Employees' AND xtype='U') CREATE TABLE Employees (EmpID NVARCHAR(10) PRIMARY KEY, Name NVARCHAR(100) NOT NULL, DeptID INT NOT NULL, RoleID INT NOT NULL, BasicSalary INT NOT NULL, JoiningDate DATE NOT NULL, Email NVARCHAR(100), Phone NVARCHAR(15), Status NVARCHAR(10) DEFAULT 'Active', FOREIGN KEY (DeptID) REFERENCES Departments(DeptID), FOREIGN KEY (RoleID) REFERENCES Roles(RoleID))`);
    await pool.request().query(`IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='SalaryComponents' AND xtype='U') CREATE TABLE SalaryComponents (CompID INT IDENTITY PRIMARY KEY, EmpID NVARCHAR(10) NOT NULL UNIQUE, BasicSalary INT DEFAULT 0, HRA_Pct DECIMAL(5,2) DEFAULT 20.00, DA_Pct DECIMAL(5,2) DEFAULT 10.00, PF_Pct DECIMAL(5,2) DEFAULT 12.00, Tax_Pct DECIMAL(5,2) DEFAULT 10.00, UpdatedOn DATETIME DEFAULT GETDATE(), FOREIGN KEY (EmpID) REFERENCES Employees(EmpID))`);
    await pool.request().query(`IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id=OBJECT_ID('SalaryComponents') AND name='BasicSalary') ALTER TABLE SalaryComponents ADD BasicSalary INT DEFAULT 0`);
    await pool.request().query(`IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='Attendance' AND xtype='U') CREATE TABLE Attendance (AttID INT IDENTITY PRIMARY KEY, EmpID NVARCHAR(10) NOT NULL, CheckIn DATETIME NOT NULL, CheckOut DATETIME, Status NVARCHAR(10) NOT NULL DEFAULT 'Present', OvertimeHours DECIMAL(4,1) DEFAULT 0, Notes NVARCHAR(200), FOREIGN KEY (EmpID) REFERENCES Employees(EmpID))`);
    await pool.request().query(`IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id=OBJECT_ID('Attendance') AND name='CheckIn') ALTER TABLE Attendance ADD CheckIn DATETIME, CheckOut DATETIME`);
    await pool.request().query(`IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='Leaves' AND xtype='U') CREATE TABLE Leaves (LeaveID INT IDENTITY PRIMARY KEY, EmpID NVARCHAR(10) NOT NULL, LeaveType NVARCHAR(20) NOT NULL DEFAULT 'Casual', Days INT NOT NULL DEFAULT 1, FromDate DATE NOT NULL, ToDate DATE NOT NULL, Reason NVARCHAR(500), Status NVARCHAR(10) NOT NULL DEFAULT 'Pending', AdminNote NVARCHAR(200), AppliedOn DATETIME DEFAULT GETDATE(), ReviewedOn DATETIME, FOREIGN KEY (EmpID) REFERENCES Employees(EmpID))`);
    await pool.request().query(`IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id=OBJECT_ID('Leaves') AND name='AdminNote') ALTER TABLE Leaves ADD AdminNote NVARCHAR(200), ReviewedOn DATETIME`);

    // Payroll - create with INT Month
    await pool.request().query(`IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='Payroll' AND xtype='U') CREATE TABLE Payroll (PayrollID INT IDENTITY PRIMARY KEY, EmpID NVARCHAR(10) NOT NULL, Month INT NOT NULL, Year INT NOT NULL, BasicSalary INT DEFAULT 0, HRA INT DEFAULT 0, DA INT DEFAULT 0, Bonus INT DEFAULT 0, GrossSalary INT DEFAULT 0, PF INT DEFAULT 0, Tax INT DEFAULT 0, LeaveDeduct INT DEFAULT 0, OvertimePay INT DEFAULT 0, TotalDeduct INT DEFAULT 0, NetSalary INT DEFAULT 0, PresentDays INT DEFAULT 0, WorkingDays INT DEFAULT 26, GeneratedOn DATETIME DEFAULT GETDATE(), FOREIGN KEY (EmpID) REFERENCES Employees(EmpID), CONSTRAINT UQ_Payroll UNIQUE (EmpID,Month,Year))`);
    // Fix Payroll.Month if NVARCHAR from old schema
    await pool.request().query(`IF EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID('Payroll') AND name='MonthInt') ALTER TABLE Payroll DROP COLUMN MonthInt`);
    await pool.request().query(`IF EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID('Payroll') AND name='Month' AND system_type_id=TYPE_ID('nvarchar')) BEGIN ALTER TABLE Payroll ADD MonthInt INT NULL; UPDATE Payroll SET MonthInt=CASE Month WHEN 'January' THEN 1 WHEN 'February' THEN 2 WHEN 'March' THEN 3 WHEN 'April' THEN 4 WHEN 'May' THEN 5 WHEN 'June' THEN 6 WHEN 'July' THEN 7 WHEN 'August' THEN 8 WHEN 'September' THEN 9 WHEN 'October' THEN 10 WHEN 'November' THEN 11 WHEN 'December' THEN 12 ELSE TRY_CAST(Month AS INT) END; IF EXISTS(SELECT 1 FROM sys.key_constraints WHERE name='UQ_Payroll') ALTER TABLE Payroll DROP CONSTRAINT UQ_Payroll; ALTER TABLE Payroll DROP COLUMN Month; EXEC sp_rename 'Payroll.MonthInt','Month','COLUMN'; ALTER TABLE Payroll ALTER COLUMN Month INT NOT NULL; END`);
    await pool.request().query(`IF NOT EXISTS (SELECT 1 FROM sys.key_constraints WHERE name='UQ_Payroll') ALTER TABLE Payroll ADD CONSTRAINT UQ_Payroll UNIQUE (EmpID,Month,Year)`);

    await pool.request().query(`IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='BonusRequests' AND xtype='U') CREATE TABLE BonusRequests (BonusID INT IDENTITY PRIMARY KEY, EmpID NVARCHAR(10) NOT NULL, Amount DECIMAL(10,2) NOT NULL, Reason NVARCHAR(500), Status NVARCHAR(10) NOT NULL DEFAULT 'Pending', AdminNote NVARCHAR(200), RequestDate DATETIME DEFAULT GETDATE(), ReviewedOn DATETIME, FOREIGN KEY (EmpID) REFERENCES Employees(EmpID))`);
    await pool.request().query(`IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='LeaveBalance' AND xtype='U') CREATE TABLE LeaveBalance (BalID INT IDENTITY PRIMARY KEY, EmpID NVARCHAR(10) NOT NULL, Year INT NOT NULL, CasualTotal INT DEFAULT 12, CasualUsed INT DEFAULT 0, SickTotal INT DEFAULT 12, SickUsed INT DEFAULT 0, EarnedTotal INT DEFAULT 15, EarnedUsed INT DEFAULT 0, FOREIGN KEY (EmpID) REFERENCES Employees(EmpID), CONSTRAINT UQ_LeaveBal UNIQUE (EmpID,Year))`);
    await pool.request().query(`IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='EmployeeCredentials' AND xtype='U') CREATE TABLE EmployeeCredentials (CredID INT IDENTITY PRIMARY KEY, EmpID NVARCHAR(10) NOT NULL UNIQUE, Password NVARCHAR(100) NOT NULL, MustChange BIT DEFAULT 1, LastLogin DATETIME, FOREIGN KEY (EmpID) REFERENCES Employees(EmpID))`);
    await pool.request().query(`IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id=OBJECT_ID('EmployeeCredentials') AND name='MustChange') ALTER TABLE EmployeeCredentials ADD MustChange BIT NOT NULL DEFAULT 1`);
    await pool.request().query(`IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id=OBJECT_ID('EmployeeCredentials') AND name='LastLogin') ALTER TABLE EmployeeCredentials ADD LastLogin DATETIME`);
    await pool.request().query(`IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='Notifications' AND xtype='U') CREATE TABLE Notifications (NotifID INT IDENTITY PRIMARY KEY, EmpID NVARCHAR(10) NOT NULL, Message NVARCHAR(500) NOT NULL, Type NVARCHAR(20) DEFAULT 'info', IsRead BIT DEFAULT 0, CreatedAt DATETIME DEFAULT GETDATE(), FOREIGN KEY (EmpID) REFERENCES Employees(EmpID))`);
    await pool.request().query(`IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='AuditLog' AND xtype='U') CREATE TABLE AuditLog (LogID INT IDENTITY PRIMARY KEY, Actor NVARCHAR(50), Action NVARCHAR(50), Target NVARCHAR(100), Detail NVARCHAR(500), CreatedAt DATETIME DEFAULT GETDATE())`);
    await pool.request().query(`IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='Performance' AND xtype='U') CREATE TABLE Performance (PerfID INT IDENTITY PRIMARY KEY, EmpID NVARCHAR(10) NOT NULL, ReviewerID NVARCHAR(10), Period NVARCHAR(20) NOT NULL, Score INT NOT NULL CHECK(Score BETWEEN 1 AND 100), Category NVARCHAR(20), Comments NVARCHAR(1000), CreatedAt DATETIME DEFAULT GETDATE(), FOREIGN KEY (EmpID) REFERENCES Employees(EmpID))`);

    console.log('[OK] All tables ready');
    await seedData(pool);
    startScheduler();
  } catch(err) { console.error('[ERROR] DB Setup:', err.message); }
}

async function seedData(pool) {
  const existing = await pool.request().query(`SELECT COUNT(*) AS cnt FROM Employees`);
  if (existing.recordset[0].cnt > 0) {
    // Just ensure credentials and balances exist
    const emps = await pool.request().query(`SELECT EmpID FROM Employees`);
    for (const e of emps.recordset) {
      await pool.request().input('id',e.EmpID).query(`IF NOT EXISTS(SELECT 1 FROM EmployeeCredentials WHERE EmpID=@id) INSERT INTO EmployeeCredentials(EmpID,Password,MustChange) VALUES(@id,@id,1)`);
      const yr = new Date().getFullYear();
      await pool.request().input('id',e.EmpID).input('y',yr).query(`IF NOT EXISTS(SELECT 1 FROM LeaveBalance WHERE EmpID=@id AND Year=@y) INSERT INTO LeaveBalance(EmpID,Year) VALUES(@id,@y)`);
    }
    console.log('[OK] Credentials & balances verified');
    return;
  }
  const depts = [
    {name:'IT',code:'IT'},{name:'HR',code:'HR'},{name:'Finance',code:'FIN'},
    {name:'Sales',code:'SAL'},{name:'Design',code:'DES'},{name:'Operations',code:'OPS'},{name:'Management',code:'MGT'}
  ];
  for (const d of depts)
    await pool.request().input('n',d.name).input('c',d.code)
      .query(`IF NOT EXISTS(SELECT 1 FROM Departments WHERE DeptName=@n) INSERT INTO Departments(DeptName,DeptCode) VALUES(@n,@c)`);
  const dm = {};
  (await pool.request().query('SELECT DeptID,DeptName FROM Departments')).recordset.forEach(d => dm[d.DeptName]=d.DeptID);

  const roles = [
    {name:'CEO',salary:200000,dept:'Management'},{name:'CTO',salary:180000,dept:'Management'},{name:'VP Engineering',salary:150000,dept:'Management'},{name:'VP HR',salary:140000,dept:'Management'},{name:'VP Sales',salary:140000,dept:'Sales'},
    {name:'Team Lead',salary:100000,dept:'IT'},{name:'Senior Developer',salary:90000,dept:'IT'},{name:'Developer',salary:70000,dept:'IT'},{name:'Junior Developer',salary:50000,dept:'IT'},{name:'DevOps Engineer',salary:85000,dept:'IT'},{name:'QA Engineer',salary:65000,dept:'IT'},
    {name:'HR Manager',salary:80000,dept:'HR'},{name:'HR Executive',salary:55000,dept:'HR'},{name:'CFO',salary:170000,dept:'Finance'},{name:'Finance Analyst',salary:75000,dept:'Finance'},{name:'Accountant',salary:60000,dept:'Finance'},
    {name:'Sales Manager',salary:85000,dept:'Sales'},{name:'Sales Executive',salary:55000,dept:'Sales'},{name:'Senior Designer',salary:80000,dept:'Design'},{name:'Designer',salary:60000,dept:'Design'},{name:'Manager',salary:90000,dept:'Operations'},{name:'Admin Executive',salary:50000,dept:'Operations'}
  ];
  for (const r of roles)
    await pool.request().input('n',r.name).input('s',r.salary).input('d',dm[r.dept])
      .query(`IF NOT EXISTS(SELECT 1 FROM Roles WHERE RoleName=@n) INSERT INTO Roles(RoleName,BaseSalary,DeptID) VALUES(@n,@s,@d)`);
  const rm = {};
  (await pool.request().query('SELECT RoleID,RoleName FROM Roles')).recordset.forEach(r => rm[r.RoleName]=r.RoleID);
  const salMap = {}; roles.forEach(r => salMap[r.name]=r.salary);

  const employees = [
    {id:'EMP001',name:'Rahul Sharma',dept:'IT',role:'Senior Developer',join:'2021-03-15',email:'rahul.s@ems.com',phone:'9876543201'},
    {id:'EMP002',name:'Priya Jain',dept:'IT',role:'Developer',join:'2022-06-01',email:'priya.j@ems.com',phone:'9876543202'},
    {id:'EMP003',name:'Amit Kumar',dept:'IT',role:'Junior Developer',join:'2023-01-10',email:'amit.k@ems.com',phone:'9876543203'},
    {id:'EMP004',name:'Sneha Verma',dept:'IT',role:'DevOps Engineer',join:'2021-09-20',email:'sneha.v@ems.com',phone:'9876543204'},
    {id:'EMP005',name:'Karan Mehta',dept:'IT',role:'QA Engineer',join:'2022-04-05',email:'karan.m@ems.com',phone:'9876543205'},
    {id:'EMP006',name:'Neha Patel',dept:'IT',role:'Team Lead',join:'2020-07-12',email:'neha.p@ems.com',phone:'9876543206'},
    {id:'EMP007',name:'Rohit Singh',dept:'IT',role:'Senior Developer',join:'2021-11-30',email:'rohit.s@ems.com',phone:'9876543207'},
    {id:'EMP008',name:'Anjali Gupta',dept:'IT',role:'Developer',join:'2023-03-22',email:'anjali.g@ems.com',phone:'9876543208'},
    {id:'EMP009',name:'Vikas Yadav',dept:'IT',role:'Junior Developer',join:'2024-01-08',email:'vikas.y@ems.com',phone:'9876543209'},
    {id:'EMP010',name:'Pooja Mishra',dept:'IT',role:'QA Engineer',join:'2022-08-14',email:'pooja.m@ems.com',phone:'9876543210'},
    {id:'EMP011',name:'Sunita Rao',dept:'HR',role:'HR Manager',join:'2019-05-10',email:'sunita.r@ems.com',phone:'9876543211'},
    {id:'EMP012',name:'Deepak Joshi',dept:'HR',role:'HR Executive',join:'2021-02-28',email:'deepak.j@ems.com',phone:'9876543212'},
    {id:'EMP013',name:'Kavita Nair',dept:'HR',role:'HR Executive',join:'2022-10-05',email:'kavita.n@ems.com',phone:'9876543213'},
    {id:'EMP014',name:'Manoj Tiwari',dept:'HR',role:'HR Manager',join:'2020-06-18',email:'manoj.t@ems.com',phone:'9876543214'},
    {id:'EMP015',name:'Rekha Agarwal',dept:'HR',role:'HR Executive',join:'2023-05-01',email:'rekha.a@ems.com',phone:'9876543215'},
    {id:'EMP016',name:'Arun Kapoor',dept:'Finance',role:'CFO',join:'2017-01-15',email:'arun.k@ems.com',phone:'9876543216'},
    {id:'EMP017',name:'Shalini Chandra',dept:'Finance',role:'Finance Analyst',join:'2021-07-20',email:'shalini.c@ems.com',phone:'9876543217'},
    {id:'EMP018',name:'Rakesh Dubey',dept:'Finance',role:'Accountant',join:'2020-03-12',email:'rakesh.d@ems.com',phone:'9876543218'},
    {id:'EMP019',name:'Nisha Pandey',dept:'Finance',role:'Finance Analyst',join:'2022-09-08',email:'nisha.p@ems.com',phone:'9876543219'},
    {id:'EMP020',name:'Suresh Malhotra',dept:'Finance',role:'Accountant',join:'2021-12-01',email:'suresh.m@ems.com',phone:'9876543220'},
    {id:'EMP021',name:'Geeta Sharma',dept:'Finance',role:'Finance Analyst',join:'2023-04-15',email:'geeta.s@ems.com',phone:'9876543221'},
    {id:'EMP022',name:'Vikram Bose',dept:'Sales',role:'VP Sales',join:'2018-08-10',email:'vikram.b@ems.com',phone:'9876543222'},
    {id:'EMP023',name:'Meena Kulkarni',dept:'Sales',role:'Sales Manager',join:'2020-11-25',email:'meena.k@ems.com',phone:'9876543223'},
    {id:'EMP024',name:'Arjun Reddy',dept:'Sales',role:'Sales Executive',join:'2022-01-10',email:'arjun.r@ems.com',phone:'9876543224'},
    {id:'EMP025',name:'Divya Iyer',dept:'Sales',role:'Sales Executive',join:'2022-06-20',email:'divya.i@ems.com',phone:'9876543225'},
    {id:'EMP026',name:'Harsh Agarwal',dept:'Sales',role:'Sales Manager',join:'2021-04-05',email:'harsh.a@ems.com',phone:'9876543226'},
    {id:'EMP027',name:'Pallavi Singh',dept:'Sales',role:'Sales Executive',join:'2023-02-14',email:'pallavi.s@ems.com',phone:'9876543227'},
    {id:'EMP028',name:'Rajan Verma',dept:'Sales',role:'Sales Executive',join:'2023-07-01',email:'rajan.v@ems.com',phone:'9876543228'},
    {id:'EMP029',name:'Ananya Roy',dept:'Design',role:'Senior Designer',join:'2020-09-15',email:'ananya.r@ems.com',phone:'9876543229'},
    {id:'EMP030',name:'Siddharth Menon',dept:'Design',role:'Designer',join:'2022-03-08',email:'sid.m@ems.com',phone:'9876543230'},
    {id:'EMP031',name:'Tanya Bhatt',dept:'Design',role:'Designer',join:'2023-01-20',email:'tanya.b@ems.com',phone:'9876543231'},
    {id:'EMP032',name:'Kunal Shah',dept:'Design',role:'Senior Designer',join:'2021-06-10',email:'kunal.s@ems.com',phone:'9876543232'},
    {id:'EMP033',name:'Ramesh Patil',dept:'Operations',role:'Manager',join:'2019-11-05',email:'ramesh.p@ems.com',phone:'9876543233'},
    {id:'EMP034',name:'Usha Devi',dept:'Operations',role:'Admin Executive',join:'2021-08-22',email:'usha.d@ems.com',phone:'9876543234'},
    {id:'EMP035',name:'Bharat Naik',dept:'Operations',role:'Admin Executive',join:'2022-05-30',email:'bharat.n@ems.com',phone:'9876543235'},
    {id:'EMP036',name:'Smita Joshi',dept:'Operations',role:'Manager',join:'2020-02-14',email:'smita.j@ems.com',phone:'9876543236'},
    {id:'EMP037',name:'Dr. Rajiv Khanna',dept:'Management',role:'CEO',join:'2015-04-01',email:'rajiv.k@ems.com',phone:'9876543237'},
    {id:'EMP038',name:'Prerna Saxena',dept:'Management',role:'CTO',join:'2016-06-15',email:'prerna.s@ems.com',phone:'9876543238'},
    {id:'EMP039',name:'Nikhil Chopra',dept:'Management',role:'VP Engineering',join:'2017-09-20',email:'nikhil.c@ems.com',phone:'9876543239'},
    {id:'EMP040',name:'Swati Rastogi',dept:'Management',role:'VP HR',join:'2018-03-10',email:'swati.r@ems.com',phone:'9876543240'}
  ];
  for (const e of employees) {
    const sal = salMap[e.role] || 40000;
    await pool.request().input('id',e.id).input('n',e.name).input('di',dm[e.dept]).input('ri',rm[e.role]).input('s',sal).input('j',e.join).input('em',e.email).input('ph',e.phone)
      .query(`IF NOT EXISTS(SELECT 1 FROM Employees WHERE EmpID=@id) INSERT INTO Employees(EmpID,Name,DeptID,RoleID,BasicSalary,JoiningDate,Email,Phone) VALUES(@id,@n,@di,@ri,@s,@j,@em,@ph)`);
    await pool.request().input('id',e.id).input('s',sal).query(`IF NOT EXISTS(SELECT 1 FROM SalaryComponents WHERE EmpID=@id) INSERT INTO SalaryComponents(EmpID,BasicSalary) VALUES(@id,@s)`);
    await pool.request().input('id',e.id).query(`IF NOT EXISTS(SELECT 1 FROM EmployeeCredentials WHERE EmpID=@id) INSERT INTO EmployeeCredentials(EmpID,Password,MustChange) VALUES(@id,@id,1)`);
    const yr = new Date().getFullYear();
    await pool.request().input('id',e.id).input('y',yr).query(`IF NOT EXISTS(SELECT 1 FROM LeaveBalance WHERE EmpID=@id AND Year=@y) INSERT INTO LeaveBalance(EmpID,Year) VALUES(@id,@y)`);
  }
  console.log('[OK] Seeded 40 employees');
}

// ======================================================================
//  AUTH
// ======================================================================
app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Enter username and password' });
  const u = username.trim(), p = password.trim();
  if (!u || !p) return res.status(400).json({ error: 'Enter username and password' });
  try {
    const ar = await q(`SELECT * FROM Users WHERE Username=@u AND Password=@p`, { u, p });
    if (ar.recordset.length) {
      const user = ar.recordset[0];
      const tok = makeToken();
      sessions[tok] = { token:tok, role:user.Role==='admin'?'admin':'user', username:user.Username, userId:user.UserID };
      await audit(user.Username,'Login','System',`Admin login`);
      return res.json({ token:tok, role:sessions[tok].role, name:user.Username });
    }
    const er = await q(`SELECT ec.*,e.Name,e.EmpID,d.DeptName,r.RoleName FROM EmployeeCredentials ec JOIN Employees e ON ec.EmpID=e.EmpID JOIN Departments d ON e.DeptID=d.DeptID JOIN Roles r ON e.RoleID=r.RoleID WHERE ec.EmpID=@u AND ec.Password=@p AND e.Status='Active'`, { u:u.toUpperCase(), p });
    if (er.recordset.length) {
      const emp = er.recordset[0];
      const tok = makeToken();
      sessions[tok] = { token:tok, role:'employee', empId:emp.EmpID, name:emp.Name, dept:emp.DeptName, roleTitle:emp.RoleName, mustChange:emp.MustChange===true||emp.MustChange===1 };
      await q(`UPDATE EmployeeCredentials SET LastLogin=GETDATE() WHERE EmpID=@e`, { e:emp.EmpID });
      await audit(emp.EmpID,'Login','Portal','Employee login');
      return res.json({ token:tok, role:'employee', name:emp.Name, empId:emp.EmpID, mustChange:sessions[tok].mustChange });
    }
    res.status(401).json({ error: 'Invalid username or password' });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/auth/logout', requireAuth, (req, res) => {
  const tok = (req.headers['authorization']||'').replace('Bearer ','').trim();
  delete sessions[tok];
  res.json({ ok:true });
});
app.get('/api/auth/me', requireAuth, (req, res) => res.json(req.session));
app.post('/api/auth/change-password', requireAuth, async (req, res) => {
  const { newPassword } = req.body;
  const s = req.session;
  if (!newPassword||newPassword.length<4) return res.status(400).json({ error: 'Min 4 characters' });
  try {
    if (s.role==='employee') {
      await q(`UPDATE EmployeeCredentials SET Password=@p,MustChange=0 WHERE EmpID=@e`, { p:newPassword,e:s.empId });
      s.mustChange = false;
    } else {
      await q(`UPDATE Users SET Password=@p WHERE Username=@u`, { p:newPassword,u:s.username });
    }
    res.json({ ok:true });
  } catch(err) { res.status(500).json({ error:err.message }); }
});

// ======================================================================
//  EMPLOYEES
// ======================================================================
app.get('/api/employees', requireAuth, async (req, res) => {
  try {
    const { search, dept, status } = req.query;
    let where = 'WHERE 1=1'; const params = {};
    if (search) { where += ' AND (e.Name LIKE @s OR e.EmpID LIKE @s OR e.Email LIKE @s)'; params.s=`%${search}%`; }
    if (dept)   { where += ' AND d.DeptName=@dept'; params.dept=dept; }
    if (status) { where += ' AND e.Status=@status'; params.status=status; }
    const r = await q(`SELECT e.EmpID,e.Name,e.BasicSalary,e.JoiningDate,e.Email,e.Phone,e.Status,d.DeptName,r.RoleName,r.RoleID,e.DeptID FROM Employees e JOIN Departments d ON e.DeptID=d.DeptID JOIN Roles r ON e.RoleID=r.RoleID ${where} ORDER BY e.EmpID`, params);
    res.json(r.recordset);
  } catch(err) { res.status(500).json({ error:err.message }); }
});
app.get('/api/employees/:id', requireAuth, async (req, res) => {
  const s = req.session;
  if (s.role==='employee'&&s.empId!==req.params.id) return res.status(403).json({ error:'Access denied' });
  try {
    const r = await q(`SELECT e.*,d.DeptName,r.RoleName FROM Employees e JOIN Departments d ON e.DeptID=d.DeptID JOIN Roles r ON e.RoleID=r.RoleID WHERE e.EmpID=@id`, { id:req.params.id });
    if (!r.recordset.length) return res.status(404).json({ error:'Not found' });
    res.json(r.recordset[0]);
  } catch(err) { res.status(500).json({ error:err.message }); }
});
app.post('/api/employees', requireAdmin, async (req, res) => {
  const { EmpID,Name,DeptID,RoleID,BasicSalary,JoiningDate,Email,Phone } = req.body;
  if (!EmpID||!Name||!DeptID||!RoleID||!BasicSalary||!JoiningDate) return res.status(400).json({ error:'Missing required fields' });
  try {
    await q(`INSERT INTO Employees(EmpID,Name,DeptID,RoleID,BasicSalary,JoiningDate,Email,Phone) VALUES(@id,@n,@di,@ri,@s,@j,@em,@ph)`, { id:EmpID,n:Name,di:DeptID,ri:RoleID,s:BasicSalary,j:JoiningDate,em:Email||null,ph:Phone||null });
    await q(`INSERT INTO SalaryComponents(EmpID,BasicSalary) VALUES(@id,@s)`, { id:EmpID,s:BasicSalary });
    await q(`INSERT INTO EmployeeCredentials(EmpID,Password,MustChange) VALUES(@id,@id,1)`, { id:EmpID });
    await q(`INSERT INTO LeaveBalance(EmpID,Year) VALUES(@id,@y)`, { id:EmpID,y:new Date().getFullYear() });
    await audit(actor(req),'Add Employee',EmpID,`Added ${Name}`);
    res.json({ ok:true, message:`${EmpID} added. Default password: ${EmpID}` });
  } catch(err) { res.status(500).json({ error:err.message }); }
});
app.put('/api/employees/:id', requireAdmin, async (req, res) => {
  const { Name,DeptID,RoleID,BasicSalary,JoiningDate,Email,Phone,Status } = req.body;
  try {
    await q(`UPDATE Employees SET Name=@n,DeptID=@di,RoleID=@ri,BasicSalary=@s,JoiningDate=@j,Email=@em,Phone=@ph,Status=@st WHERE EmpID=@id`, { n:Name,di:DeptID,ri:RoleID,s:BasicSalary,j:JoiningDate,em:Email||null,ph:Phone||null,st:Status||'Active',id:req.params.id });
    await q(`UPDATE SalaryComponents SET BasicSalary=@s WHERE EmpID=@id`, { s:BasicSalary,id:req.params.id });
    await audit(actor(req),'Edit Employee',req.params.id,`Updated ${Name}`);
    res.json({ ok:true });
  } catch(err) { res.status(500).json({ error:err.message }); }
});
app.delete('/api/employees/:id', requireAdmin, async (req, res) => {
  try {
    await q(`UPDATE Employees SET Status='Inactive' WHERE EmpID=@id`, { id:req.params.id });
    await audit(actor(req),'Delete Employee',req.params.id,'Deactivated');
    res.json({ ok:true });
  } catch(err) { res.status(500).json({ error:err.message }); }
});
app.post('/api/employees/:id/reset-password', requireAdmin, async (req, res) => {
  try {
    await q(`UPDATE EmployeeCredentials SET Password=@p,MustChange=1 WHERE EmpID=@id`, { p:req.params.id,id:req.params.id });
    res.json({ ok:true, message:`Password reset to ${req.params.id}` });
  } catch(err) { res.status(500).json({ error:err.message }); }
});

// ======================================================================
//  ATTENDANCE
// ======================================================================
app.post('/api/attendance/checkin', requireAuth, async (req, res) => {
  const s = req.session;
  const empId = s.empId || req.body.empId;
  if (!empId) return res.status(400).json({ error:'No employee ID' });
  try {
    const now = new Date(); const today = now.toISOString().slice(0,10);
    const ex = await q(`SELECT * FROM Attendance WHERE EmpID=@e AND CAST(CheckIn AS DATE)=@d`, { e:empId,d:today });
    if (ex.recordset.length && ex.recordset[0].Status!=='Absent')
      return res.status(409).json({ error:'Already checked in today' });
    const h=now.getHours(), m=now.getMinutes();
    let status = h<9||(h===9&&m<=30)?'Present':h<11?'Late':h<14?'Half-day':'Absent';
    if (ex.recordset.length) {
      await q(`UPDATE Attendance SET CheckIn=@ci,Status=@st WHERE EmpID=@e AND CAST(CheckIn AS DATE)=@d`, { ci:now.toISOString(),st:status,e:empId,d:today });
    } else {
      await q(`INSERT INTO Attendance(EmpID,CheckIn,Status) VALUES(@e,@ci,@st)`, { e:empId,ci:now.toISOString(),st:status });
    }
    if (status==='Late') await notify(empId,`Late check-in at ${now.toTimeString().slice(0,5)}. Penalty will apply.`,'warning');
    autoRecalc(empId, now.getMonth()+1, now.getFullYear()).catch(()=>{});
    res.json({ ok:true, status, time:now.toISOString() });
  } catch(err) { res.status(500).json({ error:err.message }); }
});
app.post('/api/attendance/checkout', requireAuth, async (req, res) => {
  const s = req.session; const empId = s.empId || req.body.empId;
  if (!empId) return res.status(400).json({ error:'No employee ID' });
  try {
    const now = new Date(); const today = now.toISOString().slice(0,10);
    const ex = await q(`SELECT * FROM Attendance WHERE EmpID=@e AND CAST(CheckIn AS DATE)=@d ORDER BY CheckIn DESC`, { e:empId,d:today });
    if (!ex.recordset.length) return res.status(404).json({ error:'No check-in found for today' });
    const rec = ex.recordset[0];
    if (rec.CheckOut) return res.status(409).json({ error:'Already checked out' });
    const hoursWorked = (now - new Date(rec.CheckIn)) / 3600000;
    const overtime = Math.max(0, hoursWorked - 9);
    await q(`UPDATE Attendance SET CheckOut=@co,OvertimeHours=@ot WHERE AttID=@id`, { co:now.toISOString(),ot:parseFloat(overtime.toFixed(1)),id:rec.AttID });
    autoRecalc(empId, now.getMonth()+1, now.getFullYear()).catch(()=>{});
    res.json({ ok:true, hoursWorked:hoursWorked.toFixed(1), overtime:overtime.toFixed(1) });
  } catch(err) { res.status(500).json({ error:err.message }); }
});
app.get('/api/attendance', requireAuth, async (req, res) => {
  const s = req.session;
  try {
    let where = 'WHERE 1=1'; const params = {};
    if (s.role==='employee') { where+=' AND a.EmpID=@e'; params.e=s.empId; }
    if (req.query.month) { where+=' AND MONTH(a.CheckIn)=@m'; params.m=req.query.month; }
    if (req.query.year)  { where+=' AND YEAR(a.CheckIn)=@y';  params.y=req.query.year; }
    const r = await q(`SELECT a.*,e.Name,d.DeptName FROM Attendance a JOIN Employees e ON a.EmpID=e.EmpID JOIN Departments d ON e.DeptID=d.DeptID ${where} ORDER BY a.CheckIn DESC`, params);
    res.json(r.recordset);
  } catch(err) { res.status(500).json({ error:err.message }); }
});

// ======================================================================
//  LEAVES
// ======================================================================
app.get('/api/leaves', requireAuth, async (req, res) => {
  const s = req.session;
  let where = s.role==='employee'?'WHERE l.EmpID=@e':'WHERE 1=1';
  const params = s.role==='employee'?{e:s.empId}:{};
  if (req.query.status) { where+=' AND l.Status=@st'; params.st=req.query.status; }
  try {
    const r = await q(`SELECT l.*,e.Name,d.DeptName FROM Leaves l JOIN Employees e ON l.EmpID=e.EmpID JOIN Departments d ON e.DeptID=d.DeptID ${where} ORDER BY l.AppliedOn DESC`, params);
    res.json(r.recordset);
  } catch(err) { res.status(500).json({ error:err.message }); }
});
app.post('/api/leaves', requireAuth, async (req, res) => {
  const s = req.session; if (s.role!=='employee') return res.status(403).json({ error:'Employees only' });
  const { LeaveType,FromDate,ToDate,Days,Reason } = req.body;
  if (!FromDate||!ToDate||!Days) return res.status(400).json({ error:'Missing fields' });
  try {
    await q(`INSERT INTO Leaves(EmpID,LeaveType,Days,FromDate,ToDate,Reason) VALUES(@e,@t,@d,@f,@to,@r)`, { e:s.empId,t:LeaveType||'Casual',d:Days,f:FromDate,to:ToDate,r:Reason||null });
    res.json({ ok:true });
  } catch(err) { res.status(500).json({ error:err.message }); }
});
app.put('/api/leaves/:id/review', requireAdmin, async (req, res) => {
  const { status, adminNote } = req.body;
  if (!['Approved','Rejected'].includes(status)) return res.status(400).json({ error:'Invalid status' });
  try {
    const lr = await q(`SELECT * FROM Leaves WHERE LeaveID=@id`, { id:req.params.id });
    if (!lr.recordset.length) return res.status(404).json({ error:'Not found' });
    const leave = lr.recordset[0];
    await q(`UPDATE Leaves SET Status=@st,AdminNote=@an,ReviewedOn=GETDATE() WHERE LeaveID=@id`, { st:status,an:adminNote||null,id:req.params.id });
    if (status==='Approved') {
      const lt = leave.LeaveType==='Casual'?'Casual':leave.LeaveType==='Sick'?'Sick':'Earned';
      if (['Casual','Sick','Earned'].includes(lt))
        await q(`UPDATE LeaveBalance SET ${lt}Used=${lt}Used+@d WHERE EmpID=@e AND Year=@y`, { d:leave.Days,e:leave.EmpID,y:new Date(leave.FromDate).getFullYear() }).catch(()=>{});
      await notify(leave.EmpID,`Your ${leave.LeaveType} leave (${leave.Days} day/s) has been APPROVED.`,'success');
    } else {
      await notify(leave.EmpID,`Your ${leave.LeaveType} leave was REJECTED. ${adminNote||''}`,'danger');
    }
    await audit(actor(req),status==='Approved'?'Approve Leave':'Reject Leave',leave.EmpID,`Leave ${req.params.id}`);
    res.json({ ok:true });
  } catch(err) { res.status(500).json({ error:err.message }); }
});
app.get('/api/leaves/balance', requireAuth, async (req, res) => {
  const s = req.session; const empId = s.role==='employee'?s.empId:(req.query.empId||s.empId);
  try {
    const r = await q(`SELECT * FROM LeaveBalance WHERE EmpID=@e AND Year=@y`, { e:empId,y:new Date().getFullYear() });
    res.json(r.recordset[0]||{CasualTotal:12,CasualUsed:0,SickTotal:12,SickUsed:0,EarnedTotal:15,EarnedUsed:0});
  } catch(err) { res.status(500).json({ error:err.message }); }
});

// ======================================================================
//  BONUS
// ======================================================================
app.get('/api/bonus', requireAuth, async (req, res) => {
  const s = req.session;
  const where = s.role==='employee'?'WHERE b.EmpID=@e':'WHERE 1=1';
  const params = s.role==='employee'?{e:s.empId}:{};
  try {
    const r = await q(`SELECT b.*,e.Name,d.DeptName FROM BonusRequests b JOIN Employees e ON b.EmpID=e.EmpID JOIN Departments d ON e.DeptID=d.DeptID ${where} ORDER BY b.RequestDate DESC`, params);
    res.json(r.recordset);
  } catch(err) { res.status(500).json({ error:err.message }); }
});
app.post('/api/bonus', requireAuth, async (req, res) => {
  const s = req.session; if (s.role!=='employee') return res.status(403).json({ error:'Employees only' });
  const { Amount, Reason } = req.body;
  if (!Amount||Amount<=0) return res.status(400).json({ error:'Invalid amount' });
  try {
    await q(`INSERT INTO BonusRequests(EmpID,Amount,Reason) VALUES(@e,@a,@r)`, { e:s.empId,a:Amount,r:Reason||null });
    res.json({ ok:true });
  } catch(err) { res.status(500).json({ error:err.message }); }
});
app.put('/api/bonus/:id/review', requireAdmin, async (req, res) => {
  const { status, adminNote } = req.body;
  if (!['Approved','Rejected'].includes(status)) return res.status(400).json({ error:'Invalid status' });
  try {
    const br = await q(`SELECT * FROM BonusRequests WHERE BonusID=@id`, { id:req.params.id });
    if (!br.recordset.length) return res.status(404).json({ error:'Not found' });
    const b = br.recordset[0];
    await q(`UPDATE BonusRequests SET Status=@st,AdminNote=@an,ReviewedOn=GETDATE() WHERE BonusID=@id`, { st:status,an:adminNote||null,id:req.params.id });
    const msg = status==='Approved'?`Bonus request of Rs.${b.Amount} APPROVED!`:`Bonus request REJECTED. ${adminNote||''}`;
    await notify(b.EmpID,msg,status==='Approved'?'success':'danger');
    if (status==='Approved') { const n=new Date(); autoRecalc(b.EmpID,n.getMonth()+1,n.getFullYear()).catch(()=>{}); }
    res.json({ ok:true });
  } catch(err) { res.status(500).json({ error:err.message }); }
});

// ======================================================================
//  PAYROLL
// ======================================================================
app.get('/api/salary/:empId', requireAuth, async (req, res) => {
  const s = req.session;
  if (s.role==='employee'&&s.empId!==req.params.empId) return res.status(403).json({ error:'Access denied' });
  const month=parseInt(req.query.month||new Date().getMonth()+1), year=parseInt(req.query.year||new Date().getFullYear());
  try {
    const data = await calcSalary(req.params.empId, month, year);
    if (!data) return res.status(404).json({ error:'Salary not configured' });
    res.json({ ...data, month, year, empId:req.params.empId });
  } catch(err) { res.status(500).json({ error:err.message }); }
});
app.get('/api/payroll', requireAuth, async (req, res) => {
  const s = req.session; const empId = s.role==='employee'?s.empId:(req.query.empId||null);
  try {
    let where='WHERE 1=1'; const params={};
    if (empId) { where+=' AND p.EmpID=@e'; params.e=empId; }
    if (req.query.month) { where+=' AND p.Month=@m'; params.m=req.query.month; }
    if (req.query.year)  { where+=' AND p.Year=@y';  params.y=req.query.year; }
    const r = await q(`SELECT p.*,e.Name,d.DeptName,r.RoleName FROM Payroll p JOIN Employees e ON p.EmpID=e.EmpID JOIN Departments d ON e.DeptID=d.DeptID JOIN Roles r ON e.RoleID=r.RoleID ${where} ORDER BY p.Year DESC,p.Month DESC`, params);
    res.json(r.recordset);
  } catch(err) { res.status(500).json({ error:err.message }); }
});
app.post('/api/payroll/generate', requireAdmin, async (req, res) => {
  const { month, year, empId } = req.body;
  const mo=parseInt(month||new Date().getMonth()+1), yr=parseInt(year||new Date().getFullYear());
  try {
    const pool = await getPool();
    const emps = empId
      ?(await pool.request().input('e',empId).query(`SELECT EmpID FROM Employees WHERE EmpID=@e AND Status='Active'`)).recordset
      :(await pool.request().query(`SELECT EmpID FROM Employees WHERE Status='Active'`)).recordset;
    let generated=0;
    for (const emp of emps) {
      const s = await calcSalary(emp.EmpID,mo,yr); if (!s) continue;
      await pool.request().input('e',emp.EmpID).input('m',mo).input('y',yr)
        .input('b',Math.round(s.basic)).input('h',Math.round(s.hra)).input('d',Math.round(s.da))
        .input('bn',Math.round(s.bonus)).input('g',Math.round(s.gross)).input('pf',Math.round(s.pf))
        .input('tx',Math.round(s.tax)).input('ld',Math.round(s.absentDed+s.unpaidDed))
        .input('ot',Math.round(s.otPay)).input('td',Math.round(s.totalDed))
        .input('n',s.net).input('pd',s.present).input('wd',s.workDays)
        .query(`IF EXISTS(SELECT 1 FROM Payroll WHERE EmpID=@e AND Month=@m AND Year=@y)
                  UPDATE Payroll SET BasicSalary=@b,HRA=@h,DA=@d,Bonus=@bn,GrossSalary=@g,PF=@pf,Tax=@tx,LeaveDeduct=@ld,OvertimePay=@ot,TotalDeduct=@td,NetSalary=@n,PresentDays=@pd,WorkingDays=@wd,GeneratedOn=GETDATE() WHERE EmpID=@e AND Month=@m AND Year=@y
                ELSE
                  INSERT INTO Payroll(EmpID,Month,Year,BasicSalary,HRA,DA,Bonus,GrossSalary,PF,Tax,LeaveDeduct,OvertimePay,TotalDeduct,NetSalary,PresentDays,WorkingDays) VALUES(@e,@m,@y,@b,@h,@d,@bn,@g,@pf,@tx,@ld,@ot,@td,@n,@pd,@wd)`);
      await notify(emp.EmpID,`Payslip for ${mo}/${yr} ready. Net: Rs.${s.net.toLocaleString()}`,'info');
      generated++;
    }
    await audit(actor(req),'Generate Payroll',`${mo}/${yr}`,`Generated for ${generated} employees`);
    res.json({ ok:true, generated });
  } catch(err) { res.status(500).json({ error:err.message }); }
});

// ======================================================================
//  PERFORMANCE
// ======================================================================
app.get('/api/performance', requireAuth, async (req, res) => {
  const s = req.session; const empId = s.role==='employee'?s.empId:(req.query.empId||null);
  try {
    let where='WHERE 1=1'; const params={};
    if (empId) { where+=' AND p.EmpID=@e'; params.e=empId; }
    const r = await q(`SELECT p.*,e.Name,d.DeptName FROM Performance p JOIN Employees e ON p.EmpID=e.EmpID JOIN Departments d ON e.DeptID=d.DeptID ${where} ORDER BY p.CreatedAt DESC`, params);
    res.json(r.recordset);
  } catch(err) { res.status(500).json({ error:err.message }); }
});
app.post('/api/performance', requireAdmin, async (req, res) => {
  const { EmpID,Period,Score,Category,Comments,ReviewerID } = req.body;
  if (!EmpID||!Period||!Score) return res.status(400).json({ error:'Missing fields' });
  if (Score<1||Score>100) return res.status(400).json({ error:'Score 1-100' });
  try {
    await q(`INSERT INTO Performance(EmpID,ReviewerID,Period,Score,Category,Comments) VALUES(@e,@r,@p,@s,@c,@cm)`, { e:EmpID,r:ReviewerID||null,p:Period,s:Score,c:Category||null,cm:Comments||null });
    const cat = Score>=90?'Excellent':Score>=75?'Good':Score>=60?'Average':'Needs Improvement';
    await notify(EmpID,`Performance review for ${Period}: ${Score}/100 (${cat})`,'info');
    res.json({ ok:true });
  } catch(err) { res.status(500).json({ error:err.message }); }
});

// ======================================================================
//  NOTIFICATIONS & MISC
// ======================================================================
app.get('/api/notifications', requireAuth, async (req, res) => {
  const s = req.session; if (s.role!=='employee') return res.json([]);
  try { res.json((await q(`SELECT TOP 20 * FROM Notifications WHERE EmpID=@e ORDER BY CreatedAt DESC`, { e:s.empId })).recordset); }
  catch(err) { res.status(500).json({ error:err.message }); }
});
app.post('/api/notifications/read', requireAuth, async (req, res) => {
  const s = req.session; if (s.role!=='employee') return res.json({ ok:true });
  try { await q(`UPDATE Notifications SET IsRead=1 WHERE EmpID=@e`, { e:s.empId }); res.json({ ok:true }); }
  catch(err) { res.status(500).json({ error:err.message }); }
});
app.get('/api/departments', requireAuth, async (req, res) => {
  try { res.json((await q('SELECT * FROM Departments ORDER BY DeptName')).recordset); } catch(err) { res.status(500).json({ error:err.message }); }
});
app.get('/api/roles', requireAuth, async (req, res) => {
  try { res.json((await q('SELECT * FROM Roles ORDER BY RoleName')).recordset); } catch(err) { res.status(500).json({ error:err.message }); }
});
app.get('/api/salary-components/:empId', requireAuth, async (req, res) => {
  const s = req.session;
  if (s.role==='employee'&&s.empId!==req.params.empId) return res.status(403).json({ error:'Access denied' });
  try { res.json((await q(`SELECT * FROM SalaryComponents WHERE EmpID=@e`, { e:req.params.empId })).recordset[0]||null); }
  catch(err) { res.status(500).json({ error:err.message }); }
});
app.put('/api/salary-components/:empId', requireAdmin, async (req, res) => {
  const { BasicSalary,HRA_Pct,DA_Pct,PF_Pct,Tax_Pct } = req.body;
  try {
    await q(`IF EXISTS(SELECT 1 FROM SalaryComponents WHERE EmpID=@e) UPDATE SalaryComponents SET BasicSalary=@b,HRA_Pct=@h,DA_Pct=@d,PF_Pct=@pf,Tax_Pct=@tx,UpdatedOn=GETDATE() WHERE EmpID=@e ELSE INSERT INTO SalaryComponents(EmpID,BasicSalary,HRA_Pct,DA_Pct,PF_Pct,Tax_Pct) VALUES(@e,@b,@h,@d,@pf,@tx)`,
      { e:req.params.empId,b:BasicSalary,h:HRA_Pct||20,d:DA_Pct||10,pf:PF_Pct||12,tx:Tax_Pct||10 });
    res.json({ ok:true });
  } catch(err) { res.status(500).json({ error:err.message }); }
});
app.get('/api/audit', requireAdmin, async (req, res) => {
  try { res.json((await q(`SELECT TOP ${parseInt(req.query.limit)||100} * FROM AuditLog ORDER BY CreatedAt DESC`)).recordset); }
  catch(err) { res.status(500).json({ error:err.message }); }
});

// ======================================================================
//  DASHBOARD
// ======================================================================
app.get('/api/dashboard/admin', requireAdmin, async (req, res) => {
  try {
    const pool=await getPool(), today=new Date().toISOString().slice(0,10), now=new Date();
    const mo=now.getMonth()+1, yr=now.getFullYear();
    const [empCount,attToday,pendingLeaves,pendingBonus,payrollTotal,deptDist,recentAudit,perfAvg] = await Promise.all([
      pool.request().query(`SELECT COUNT(*) AS total,SUM(CASE WHEN Status='Active' THEN 1 ELSE 0 END) AS active FROM Employees`),
      pool.request().input('d',today).query(`SELECT COUNT(*) AS total,SUM(CASE WHEN Status='Present' THEN 1 ELSE 0 END) AS present,SUM(CASE WHEN Status='Late' THEN 1 ELSE 0 END) AS late,SUM(CASE WHEN Status='Absent' THEN 1 ELSE 0 END) AS absent,SUM(CASE WHEN Status='Half-day' THEN 1 ELSE 0 END) AS halfday FROM Attendance WHERE CAST(CheckIn AS DATE)=@d`),
      pool.request().query(`SELECT COUNT(*) AS cnt FROM Leaves WHERE Status='Pending'`),
      pool.request().query(`SELECT COUNT(*) AS cnt FROM BonusRequests WHERE Status='Pending'`),
      pool.request().input('m',mo).input('y',yr).query(`SELECT ISNULL(SUM(NetSalary),0) AS total FROM Payroll WHERE Month=@m AND Year=@y`),
      pool.request().query(`SELECT d.DeptName,COUNT(e.EmpID) AS cnt FROM Departments d LEFT JOIN Employees e ON d.DeptID=e.DeptID AND e.Status='Active' GROUP BY d.DeptName`),
      pool.request().query(`SELECT TOP 10 * FROM AuditLog ORDER BY CreatedAt DESC`),
      pool.request().query(`SELECT AVG(CAST(Score AS FLOAT)) AS avg,MAX(Score) AS max,MIN(Score) AS min FROM Performance`)
    ]);
    res.json({ employees:empCount.recordset[0], attendance:attToday.recordset[0], pendingLeaves:pendingLeaves.recordset[0].cnt, pendingBonus:pendingBonus.recordset[0].cnt, payrollTotal:payrollTotal.recordset[0].total, departments:deptDist.recordset, recentAudit:recentAudit.recordset, performance:perfAvg.recordset[0] });
  } catch(err) { res.status(500).json({ error:err.message }); }
});

app.get('/api/dashboard/employee', requireAuth, async (req, res) => {
  const s = req.session; if (s.role!=='employee') return res.status(403).json({ error:'Employee only' });
  try {
    const now=new Date(), mo=now.getMonth()+1, yr=now.getFullYear(), today=now.toISOString().slice(0,10);
    const [emp,salary,todayAtt,attSummary,leaves,leaveBalance,notifs,perf] = await Promise.all([
      q(`SELECT e.*,d.DeptName,r.RoleName FROM Employees e JOIN Departments d ON e.DeptID=d.DeptID JOIN Roles r ON e.RoleID=r.RoleID WHERE e.EmpID=@e`, { e:s.empId }),
      calcSalary(s.empId,mo,yr),
      q(`SELECT TOP 1 * FROM Attendance WHERE EmpID=@e AND CAST(CheckIn AS DATE)=@d ORDER BY CheckIn DESC`, { e:s.empId,d:today }),
      q(`SELECT COUNT(*) AS total,SUM(CASE WHEN Status IN ('Present','Late') THEN 1 ELSE 0 END) AS present,SUM(CASE WHEN Status='Absent' THEN 1 ELSE 0 END) AS absent,SUM(CASE WHEN Status='Late' THEN 1 ELSE 0 END) AS late,ISNULL(SUM(OvertimeHours),0) AS ot FROM Attendance WHERE EmpID=@e AND MONTH(CheckIn)=@m AND YEAR(CheckIn)=@y`, { e:s.empId,m:mo,y:yr }),
      q(`SELECT TOP 5 * FROM Leaves WHERE EmpID=@e ORDER BY AppliedOn DESC`, { e:s.empId }),
      q(`SELECT * FROM LeaveBalance WHERE EmpID=@e AND Year=@y`, { e:s.empId,y:yr }),
      q(`SELECT TOP 5 * FROM Notifications WHERE EmpID=@e AND IsRead=0 ORDER BY CreatedAt DESC`, { e:s.empId }),
      q(`SELECT TOP 3 * FROM Performance WHERE EmpID=@e ORDER BY CreatedAt DESC`, { e:s.empId })
    ]);
    res.json({ employee:emp.recordset[0], salary, todayAtt:todayAtt.recordset[0]||null, attSummary:attSummary.recordset[0], recentLeaves:leaves.recordset, leaveBalance:leaveBalance.recordset[0]||null, notifications:notifs.recordset, performance:perf.recordset });
  } catch(err) { res.status(500).json({ error:err.message }); }
});


// ======================================================================
//  FRONTEND
// ======================================================================
app.get('*', (req, res) => res.send(buildPage()));

function buildPage() { return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>EMS - Enterprise HR Platform</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet">
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#f8fafc;--surface:#ffffff;--surface2:#f1f5f9;
  --accent:#3b82f6;--accent-dark:#2563eb;--accent-light:#eff6ff;
  --green:#10b981;--green-light:#ecfdf5;--red:#ef4444;--red-light:#fef2f2;
  --yellow:#f59e0b;--yellow-light:#fffbeb;--purple:#8b5cf6;--purple-light:#f5f3ff;
  --text:#0f172a;--text2:#475569;--text3:#94a3b8;
  --border:#e2e8f0;--border2:#cbd5e1;
  --shadow:0 1px 3px rgba(0,0,0,.08),0 1px 2px rgba(0,0,0,.04);
  --shadow-md:0 4px 12px rgba(0,0,0,.08),0 2px 4px rgba(0,0,0,.04);
  --shadow-lg:0 10px 25px rgba(0,0,0,.1),0 4px 8px rgba(0,0,0,.05);
  --r:8px;--r-sm:6px;--r-xs:4px;
}
html{scroll-behavior:smooth}
body{font-family:'Inter',system-ui,sans-serif;background:var(--bg);color:var(--text);min-height:100vh;overflow:hidden;font-size:14px;line-height:1.5}
::-webkit-scrollbar{width:5px;height:5px}
::-webkit-scrollbar-track{background:transparent}
::-webkit-scrollbar-thumb{background:var(--border2);border-radius:10px}

/* === LAYOUT === */
#app{display:flex;height:100vh}
#sidebar{width:220px;min-width:220px;background:var(--surface);border-right:1px solid var(--border);display:flex;flex-direction:column;height:100vh;overflow:hidden;transition:width .25s;box-shadow:var(--shadow)}
#sidebar.collapsed{width:56px;min-width:56px}
#main{flex:1;display:flex;flex-direction:column;height:100vh;overflow:hidden;min-width:0}
#topbar{height:52px;min-height:52px;background:var(--surface);border-bottom:1px solid var(--border);display:flex;align-items:center;padding:0 20px;gap:12px;z-index:10}
#content{flex:1;overflow-y:auto;padding:20px;background:var(--bg)}

/* === SIDEBAR === */
.sb-logo{padding:14px 16px 12px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:10px;overflow:hidden;white-space:nowrap;min-height:52px}
.sb-logo-icon{width:30px;height:30px;min-width:30px;background:var(--accent);border-radius:var(--r-sm);display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:700;color:#fff;flex-shrink:0}
.sb-logo-text{font-weight:700;font-size:15px;letter-spacing:-.3px;color:var(--text);overflow:hidden;text-overflow:ellipsis}
.sb-user{padding:10px 12px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:9px;overflow:hidden;min-height:52px}
.sb-avatar{width:32px;height:32px;min-width:32px;border-radius:50%;background:linear-gradient(135deg,var(--accent),var(--purple));display:flex;align-items:center;justify-content:center;font-weight:600;font-size:12px;color:#fff;flex-shrink:0}
.sb-user-name{font-size:13px;font-weight:500;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sb-user-role{font-size:10px;color:var(--text3);text-transform:uppercase;letter-spacing:.8px;margin-top:1px}
.sb-nav{flex:1;overflow-y:auto;padding:6px 0}
.sb-section{padding:8px 14px 3px;font-size:9px;color:var(--text3);letter-spacing:1.5px;text-transform:uppercase;font-weight:600;overflow:hidden;white-space:nowrap}
.sb-item{display:flex;align-items:center;gap:9px;padding:7px 14px;color:var(--text2);text-decoration:none;font-size:13px;cursor:pointer;transition:all .15s;border-left:2px solid transparent;overflow:hidden;white-space:nowrap}
.sb-item:hover{color:var(--text);background:var(--surface2)}
.sb-item.active{color:var(--accent);background:var(--accent-light);border-left-color:var(--accent);font-weight:500}
.sb-icon{width:16px;min-width:16px;display:flex;align-items:center;justify-content:center;opacity:.6}
.sb-item.active .sb-icon{opacity:1}
.sb-item:hover .sb-icon{opacity:.8}
.sb-badge{margin-left:auto;background:var(--red);color:#fff;font-size:9px;padding:1px 5px;border-radius:10px;font-weight:700;flex-shrink:0}
.sb-footer{padding:10px 12px;border-top:1px solid var(--border)}
.collapsed .sb-section,.collapsed .sb-user-name,.collapsed .sb-user-role,.collapsed .sb-logo-text,.collapsed span:not(.sb-badge){display:none}
.collapsed .sb-item{padding:7px;justify-content:center}
.collapsed .sb-badge{position:absolute;right:4px;top:4px}

/* === TOPBAR === */
.tb-title{font-size:15px;font-weight:600;color:var(--text);flex:1}
.tb-btn{background:none;border:1px solid var(--border);color:var(--text2);padding:5px 10px;border-radius:var(--r-xs);cursor:pointer;font-size:12px;font-family:inherit;transition:all .15s;display:flex;align-items:center;gap:5px;position:relative}
.tb-btn:hover{border-color:var(--accent);color:var(--accent);background:var(--accent-light)}
.tb-dot{position:absolute;top:-3px;right:-3px;width:14px;height:14px;background:var(--red);border-radius:50%;font-size:8px;display:flex;align-items:center;justify-content:center;color:#fff;font-weight:700}

/* === PAGES === */
.page{display:none}.page.active{display:block}

/* === CARDS === */
.card{background:var(--surface);border:1px solid var(--border);border-radius:var(--r);padding:18px;box-shadow:var(--shadow)}
.card-hdr{font-size:12px;font-weight:600;color:var(--text);margin-bottom:14px;display:flex;align-items:center;gap:7px;text-transform:uppercase;letter-spacing:.5px}
.card-hdr svg{opacity:.5}

/* === STATS === */
.stats-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px;margin-bottom:18px}
.stat{background:var(--surface);border:1px solid var(--border);border-radius:var(--r);padding:16px;transition:box-shadow .2s,transform .15s;box-shadow:var(--shadow);cursor:default;position:relative;overflow:hidden}
.stat::before{content:'';position:absolute;top:0;left:0;right:0;height:3px;background:var(--accent)}
.stat.green::before{background:var(--green)}
.stat.red::before{background:var(--red)}
.stat.yellow::before{background:var(--yellow)}
.stat.purple::before{background:var(--purple)}
.stat:hover{box-shadow:var(--shadow-md);transform:translateY(-1px)}
.stat-icon{width:34px;height:34px;border-radius:var(--r-sm);display:flex;align-items:center;justify-content:center;margin-bottom:10px;background:var(--accent-light);color:var(--accent)}
.stat.green .stat-icon{background:var(--green-light);color:var(--green)}
.stat.red .stat-icon{background:var(--red-light);color:var(--red)}
.stat.yellow .stat-icon{background:var(--yellow-light);color:var(--yellow)}
.stat.purple .stat-icon{background:var(--purple-light);color:var(--purple)}
.stat-val{font-size:22px;font-weight:700;color:var(--text);line-height:1}
.stat-lbl{font-size:11px;color:var(--text3);margin-top:3px;text-transform:uppercase;letter-spacing:.5px}

/* === TABLES === */
.tbl-wrap{overflow-x:auto;border-radius:var(--r);border:1px solid var(--border);background:var(--surface);box-shadow:var(--shadow)}
table{width:100%;border-collapse:collapse;font-size:13px}
thead tr{background:var(--surface2)}
th{padding:9px 13px;text-align:left;font-size:10px;font-weight:600;color:var(--text3);text-transform:uppercase;letter-spacing:1px;white-space:nowrap;border-bottom:1px solid var(--border)}
td{padding:10px 13px;border-bottom:1px solid var(--border);color:var(--text2);vertical-align:middle}
tr:last-child td{border-bottom:none}
tbody tr{transition:background .1s}
tbody tr:hover{background:var(--surface2)}
.emp-cell{display:flex;align-items:center;gap:8px}
.emp-av{width:28px;height:28px;border-radius:50%;background:linear-gradient(135deg,var(--accent),var(--purple));display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;color:#fff;flex-shrink:0}

/* === BADGES === */
.badge{display:inline-flex;align-items:center;padding:2px 8px;border-radius:20px;font-size:11px;font-weight:500}
.badge-green{background:var(--green-light);color:var(--green)}
.badge-red{background:var(--red-light);color:var(--red)}
.badge-yellow{background:var(--yellow-light);color:var(--yellow)}
.badge-blue{background:var(--accent-light);color:var(--accent)}
.badge-purple{background:var(--purple-light);color:var(--purple)}

/* === BUTTONS === */
.btn{display:inline-flex;align-items:center;gap:5px;padding:7px 14px;border-radius:var(--r-xs);font-size:13px;font-weight:500;cursor:pointer;border:none;text-decoration:none;transition:all .15s;font-family:inherit;white-space:nowrap;line-height:1.2}
.btn-primary{background:var(--accent);color:#fff}.btn-primary:hover{background:var(--accent-dark)}
.btn-green{background:var(--green);color:#fff}.btn-green:hover{background:#059669}
.btn-red{background:var(--red);color:#fff}.btn-red:hover{background:#dc2626}
.btn-ghost{background:transparent;color:var(--text2);border:1px solid var(--border)}.btn-ghost:hover{border-color:var(--accent);color:var(--accent);background:var(--accent-light)}
.btn-sm{padding:4px 10px;font-size:12px}.btn-xs{padding:3px 7px;font-size:11px}

/* === FORMS === */
.form-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px}
.fg{display:flex;flex-direction:column;gap:3px}
.fg label{font-size:11px;font-weight:600;color:var(--text2);text-transform:uppercase;letter-spacing:.5px}
.fg input,.fg select,.fg textarea{background:var(--surface2);border:1px solid var(--border);color:var(--text);padding:7px 10px;border-radius:var(--r-xs);font-size:13px;font-family:inherit;transition:border-color .15s;outline:none}
.fg input:focus,.fg select:focus,.fg textarea:focus{border-color:var(--accent);background:var(--surface);box-shadow:0 0 0 3px rgba(59,130,246,.1)}
.fg textarea{resize:vertical;min-height:65px}
.form-actions{display:flex;gap:8px;padding-top:4px;flex-wrap:wrap}

/* === MODAL === */
.overlay{position:fixed;inset:0;background:rgba(15,23,42,.4);backdrop-filter:blur(3px);z-index:999;display:none;align-items:center;justify-content:center;padding:20px}
.overlay.open{display:flex}
.modal{background:var(--surface);border:1px solid var(--border);border-radius:var(--r);width:100%;max-width:540px;max-height:90vh;overflow-y:auto;box-shadow:var(--shadow-lg);animation:mIn .18s ease}
@keyframes mIn{from{transform:translateY(10px);opacity:0}to{transform:none;opacity:1}}
.modal-hdr{padding:14px 18px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between}
.modal-ttl{font-size:14px;font-weight:600;color:var(--text)}
.modal-cls{background:none;border:none;color:var(--text3);font-size:17px;cursor:pointer;line-height:1;padding:2px;transition:color .15s}
.modal-cls:hover{color:var(--red)}
.modal-body{padding:18px}
.modal-ftr{padding:12px 18px;border-top:1px solid var(--border);display:flex;gap:8px;justify-content:flex-end}

/* === TOOLBAR === */
.toolbar{display:flex;align-items:center;gap:8px;margin-bottom:12px;flex-wrap:wrap}
.search-wrap{display:flex;align-items:center;gap:7px;background:var(--surface);border:1px solid var(--border);border-radius:var(--r-xs);padding:6px 10px;flex:1;min-width:160px;max-width:280px}
.search-wrap input{background:none;border:none;color:var(--text);font-size:13px;outline:none;width:100%;font-family:inherit}
.search-wrap input::placeholder{color:var(--text3)}
select.filter{background:var(--surface);border:1px solid var(--border);color:var(--text2);padding:6px 10px;border-radius:var(--r-xs);font-size:12px;outline:none;cursor:pointer;font-family:inherit}

/* === CHARTS === */
.charts-row{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:14px;margin-bottom:18px}

/* === LOGIN === */
#login-page{position:fixed;inset:0;background:linear-gradient(135deg,#f8fafc 0%,#eff6ff 100%);display:flex;align-items:center;justify-content:center;z-index:9999}
.login-box{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:32px;width:100%;max-width:380px;box-shadow:var(--shadow-lg)}
.login-logo{text-align:center;margin-bottom:24px}
.login-logo .brand{font-size:24px;font-weight:700;color:var(--text);letter-spacing:-.5px}
.login-logo .brand span{color:var(--accent)}
.login-logo .sub{font-size:11px;color:var(--text3);margin-top:3px;letter-spacing:1px;text-transform:uppercase}
.login-hint{background:var(--surface2);border:1px solid var(--border);border-radius:var(--r-xs);padding:10px 12px;font-size:12px;color:var(--text2);margin-bottom:18px;line-height:1.7}
.login-err{background:var(--red-light);border:1px solid rgba(239,68,68,.2);color:var(--red);padding:8px 12px;border-radius:var(--r-xs);font-size:13px;margin-top:10px;display:none}
.login-err.show{display:block}

/* === PAYSLIP === */
.payslip{background:var(--surface);border:1px solid var(--border);border-radius:var(--r);padding:28px;max-width:650px;margin:0 auto}
.payslip-hdr{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:20px;padding-bottom:14px;border-bottom:2px solid var(--border)}
.payslip-co{font-size:18px;font-weight:700;color:var(--text)}
.payslip-co span{color:var(--accent)}
.ps-row{display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--border);font-size:13px}
.ps-row:last-child{border-bottom:none}
.ps-row.total{font-weight:700;font-size:14px;color:var(--green);border-top:2px solid var(--border);margin-top:5px;padding-top:9px}
.ps-sec{font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:1px;color:var(--text3);margin:14px 0 6px}

/* === CHECKIN === */
.checkin-box{background:linear-gradient(135deg,#eff6ff,#f5f3ff);border:1px solid rgba(59,130,246,.2);border-radius:var(--r);padding:20px;text-align:center;margin-bottom:16px}
.live-time{font-size:32px;font-weight:700;color:var(--text);letter-spacing:-1px}
.live-date{font-size:12px;color:var(--text3);margin:2px 0 14px}

/* === ALERTS === */
.alert{padding:8px 12px;border-radius:var(--r-xs);font-size:13px;margin-bottom:8px;display:none}
.alert.show{display:block}
.alert-green{background:var(--green-light);border:1px solid rgba(16,185,129,.2);color:var(--green)}
.alert-red{background:var(--red-light);border:1px solid rgba(239,68,68,.2);color:var(--red)}
.alert-blue{background:var(--accent-light);border:1px solid rgba(59,130,246,.2);color:var(--accent)}

/* === BAR === */
.bar-wrap{background:var(--surface2);border-radius:4px;height:5px;overflow:hidden;margin:5px 0}
.bar{height:100%;border-radius:4px;transition:width .5s ease}

/* === NOTIF PANEL === */
.notif-panel{position:absolute;top:48px;right:16px;background:var(--surface);border:1px solid var(--border);border-radius:var(--r);width:300px;max-height:360px;overflow-y:auto;z-index:200;box-shadow:var(--shadow-lg);display:none}
.notif-panel.open{display:block}
.notif-item{padding:10px 13px;border-bottom:1px solid var(--border);font-size:12px;color:var(--text2);cursor:default}
.notif-item.unread{border-left:3px solid var(--accent)}
.notif-item:hover{background:var(--surface2)}
.notif-time{font-size:10px;color:var(--text3);margin-top:2px}

/* === PERF SCORE === */
.score-circle{width:50px;height:50px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:15px;border:3px solid}
.score-ex{border-color:var(--green);color:var(--green);background:var(--green-light)}
.score-gd{border-color:var(--accent);color:var(--accent);background:var(--accent-light)}
.score-av{border-color:var(--yellow);color:var(--yellow);background:var(--yellow-light)}
.score-po{border-color:var(--red);color:var(--red);background:var(--red-light)}

/* === TWO-COL GRID === */
.two-col{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:18px}
@media(max-width:900px){.two-col{grid-template-columns:1fr}}

/* === PRINT === */
@media print{#sidebar,#topbar,.no-print{display:none!important}#content{padding:0}.payslip{border:1px solid #ccc;padding:20px}}

/* === RESPONSIVE === */
@media(max-width:768px){#sidebar{position:fixed;z-index:100;transform:translateX(-100%)}#sidebar.mobile-open{transform:translateX(0)}.stats-grid{grid-template-columns:1fr 1fr}.charts-row{grid-template-columns:1fr}.two-col{grid-template-columns:1fr}}
</style>
</head>
<body>

<!-- LOGIN -->
<div id="login-page">
  <div class="login-box">
    <div class="login-logo">
      <div class="brand">EMS<span>.</span>HR</div>
      <div class="sub">Enterprise HR Platform</div>
    </div>
    <div class="login-hint">
      <strong>Admin:</strong> admin / admin123 &nbsp;|&nbsp; user / user123<br>
      <strong>Employee:</strong> EmpID as both username &amp; password
    </div>
    <div style="display:flex;flex-direction:column;gap:10px">
      <div class="fg"><label>Username / Employee ID</label><input type="text" id="li-u" placeholder="admin or EMP001" autocomplete="username" onkeydown="if(event.key==='Enter')doLogin()"></div>
      <div class="fg"><label>Password</label><input type="password" id="li-p" placeholder="Password" autocomplete="current-password" onkeydown="if(event.key==='Enter')doLogin()"></div>
    </div>
    <div style="margin-top:14px">
      <button class="btn btn-primary" style="width:100%;justify-content:center;padding:10px" onclick="doLogin()">Sign In</button>
    </div>
    <div id="login-err" class="login-err"></div>
  </div>
</div>

<!-- APP -->
<div id="app" style="display:none">
  <div id="sidebar">
    <div class="sb-logo">
      <div class="sb-logo-icon">HR</div>
      <div class="sb-logo-text">EMS&middot;HR</div>
    </div>
    <div class="sb-user">
      <div class="sb-avatar" id="sb-av">A</div>
      <div style="overflow:hidden">
        <div class="sb-user-name" id="sb-name">-</div>
        <div class="sb-user-role" id="sb-role">-</div>
      </div>
    </div>
    <nav class="sb-nav" id="sb-nav"></nav>
    <div class="sb-footer">
      <div class="sb-item" onclick="doLogout()">
        <span class="sb-icon"><svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/></svg></span>
        <span>Sign Out</span>
      </div>
    </div>
  </div>

  <div id="main">
    <div id="topbar">
      <button class="tb-btn" onclick="toggleSidebar()" style="padding:5px 7px">
        <svg width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
      </button>
      <div class="tb-title" id="tb-title">Dashboard</div>
      <div style="display:flex;align-items:center;gap:8px;position:relative">
        <button class="tb-btn" id="notif-btn" onclick="toggleNotif()" style="display:none">
          Notifications<span class="tb-dot" id="notif-cnt" style="display:none">0</span>
        </button>
        <button class="tb-btn" onclick="showPage('profile')">Profile</button>
      </div>
    </div>
    <div class="notif-panel" id="notif-panel">
      <div style="padding:10px 13px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center">
        <span style="font-size:12px;font-weight:600">Notifications</span>
        <button class="btn btn-xs btn-ghost" onclick="markRead()">Mark all read</button>
      </div>
      <div id="notif-list"><div style="padding:14px;text-align:center;color:var(--text3)">No notifications</div></div>
    </div>
    <div id="content">
      <div class="page" id="page-dashboard"></div>
      <div class="page" id="page-employees"></div>
      <div class="page" id="page-attendance"></div>
      <div class="page" id="page-leaves"></div>
      <div class="page" id="page-bonus"></div>
      <div class="page" id="page-payroll"></div>
      <div class="page" id="page-performance"></div>
      <div class="page" id="page-audit"></div>
      <div class="page" id="page-profile"></div>
    </div>
  </div>
</div>

<!-- MODAL -->
<div class="overlay" id="overlay" onclick="if(event.target===this)closeModal()">
  <div class="modal" id="modal">
    <div class="modal-hdr">
      <div class="modal-ttl" id="modal-ttl">-</div>
      <button class="modal-cls" onclick="closeModal()">&times;</button>
    </div>
    <div class="modal-body" id="modal-body"></div>
    <div class="modal-ftr" id="modal-ftr" style="display:none"></div>
  </div>
</div>

<script>
let TOKEN = localStorage.getItem('ems_tok')||'';
let SESSION = JSON.parse(localStorage.getItem('ems_sess')||'null');
let curPage='', clockInt=null, pollInt=null, deptChart=null, attChart=null;

// API
async function api(method,url,body){
  const r = await fetch(url,{ method, headers:{'Content-Type':'application/json','Authorization':'Bearer '+TOKEN}, body:body?JSON.stringify(body):undefined });
  const d = await r.json().catch(()=>({}));
  if (!r.ok) throw new Error(d.error||r.statusText);
  return d;
}
const GET=(u)=>api('GET',u), POST=(u,b)=>api('POST',u,b), PUT=(u,b)=>api('PUT',u,b), DEL=(u)=>api('DELETE',u);

// AUTH
async function doLogin(){
  const u=document.getElementById('li-u').value.trim(), p=document.getElementById('li-p').value.trim();
  const err=document.getElementById('login-err'); err.classList.remove('show');
  if(!u||!p){err.textContent='Enter username and password';err.classList.add('show');return;}
  try{
    const d=await POST('/api/auth/login',{username:u,password:p});
    TOKEN=d.token; SESSION=d;
    localStorage.setItem('ems_tok',TOKEN); localStorage.setItem('ems_sess',JSON.stringify(SESSION));
    initApp();
  }catch(e){err.textContent=e.message||'Login failed';err.classList.add('show');}
}
async function doLogout(){
  try{await POST('/api/auth/logout');}catch(_){}
  TOKEN='';SESSION=null;
  localStorage.removeItem('ems_tok');localStorage.removeItem('ems_sess');
  location.reload();
}

// INIT
function initApp(){
  document.getElementById('login-page').style.display='none';
  document.getElementById('app').style.display='flex';
  buildSidebar();
  if(SESSION.role==='employee'){
    document.getElementById('notif-btn').style.display='flex';
    startPoll();
    if(SESSION.mustChange) setTimeout(()=>showChangePwModal(),800);
  }
  showPage('dashboard');
}

// SIDEBAR
function svgIcon(d){return \`<svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">\${d}</svg>\`;}
const ICONS = {
  dash: svgIcon('<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/>'),
  emps: svgIcon('<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>'),
  att:  svgIcon('<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>'),
  leave:svgIcon('<path d="M9 12h6M9 16h6M9 8h6M5 3h14a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/>'),
  bonus:svgIcon('<circle cx="12" cy="12" r="10"/><path d="M12 8v8M8 12h8"/>'),
  pay:  svgIcon('<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/>'),
  perf: svgIcon('<polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>'),
  audit:svgIcon('<circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>'),
  prof: svgIcon('<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>')
};
function sbItem(page,icon,label,badge){
  return \`<div class="sb-item" onclick="showPage('\${page}')"><span class="sb-icon">\${icon}</span><span>\${label}</span>\${badge||''}</div>\`;
}
function buildSidebar(){
  const s=SESSION;
  document.getElementById('sb-name').textContent=s.name||s.username;
  document.getElementById('sb-role').textContent=s.role==='employee'?(s.roleTitle||'Employee'):s.role.toUpperCase();
  document.getElementById('sb-av').textContent=(s.name||s.username||'U')[0].toUpperCase();
  const nav=document.getElementById('sb-nav');
  const isEmp=s.role==='employee';
  if(isEmp){
    nav.innerHTML=\`<div class="sb-section">My Portal</div>
\${sbItem('dashboard',ICONS.dash,'Dashboard')}
\${sbItem('attendance',ICONS.att,'My Attendance')}
\${sbItem('leaves',ICONS.leave,'My Leaves')}
\${sbItem('bonus',ICONS.bonus,'Bonus Requests')}
\${sbItem('payroll',ICONS.pay,'Payslips')}
\${sbItem('performance',ICONS.perf,'Performance')}
\${sbItem('profile',ICONS.prof,'My Profile')}\`;
  } else {
    nav.innerHTML=\`<div class="sb-section">Overview</div>
\${sbItem('dashboard',ICONS.dash,'Dashboard')}
<div class="sb-section">HR Management</div>
\${sbItem('employees',ICONS.emps,'Employees')}
\${sbItem('attendance',ICONS.att,'Attendance')}
\${sbItem('leaves',ICONS.leave,'Leave Requests','<span class="sb-badge" id="sb-lv" style="display:none">0</span>')}
\${sbItem('bonus',ICONS.bonus,'Bonus Requests','<span class="sb-badge" id="sb-bn" style="display:none">0</span>')}
<div class="sb-section">Payroll</div>
\${sbItem('payroll',ICONS.pay,'Payroll')}
\${sbItem('performance',ICONS.perf,'Performance')}
<div class="sb-section">System</div>
\${sbItem('audit',ICONS.audit,'Audit Log')}\`;
  }
}

// ROUTING
const TITLES={dashboard:'Dashboard',employees:'Employees',attendance:'Attendance',leaves:'Leave Requests',bonus:'Bonus Requests',payroll:'Payroll',performance:'Performance',audit:'Audit Log',profile:'My Profile'};
function showPage(page){
  document.querySelectorAll('.page').forEach(p=>p.classList.remove('active'));
  document.querySelectorAll('.sb-item').forEach(i=>i.classList.remove('active'));
  const el=document.getElementById('page-'+page);
  if(el) el.classList.add('active');
  document.querySelectorAll('.sb-item').forEach(i=>{
    if(i.textContent.trim().toLowerCase().startsWith((TITLES[page]||page).toLowerCase().split(' ')[0].toLowerCase())) i.classList.add('active');
  });
  document.getElementById('tb-title').textContent=TITLES[page]||page;
  curPage=page; loadPage(page);
}
async function loadPage(p){
  switch(p){
    case 'dashboard':   return SESSION.role==='employee'?loadEmpDash():loadAdminDash();
    case 'employees':   return loadEmployees();
    case 'attendance':  return loadAttendance();
    case 'leaves':      return loadLeaves();
    case 'bonus':       return loadBonus();
    case 'payroll':     return loadPayroll();
    case 'performance': return loadPerformance();
    case 'audit':       return loadAudit();
    case 'profile':     return loadProfile();
  }
}

// ADMIN DASHBOARD
async function loadAdminDash(){
  const el=document.getElementById('page-dashboard');
  el.innerHTML='<div style="color:var(--text3);padding:40px;text-align:center">Loading...</div>';
  try{
    const d=await GET('/api/dashboard/admin');
    const lc=document.getElementById('sb-lv'), bc=document.getElementById('sb-bn');
    if(lc){lc.textContent=d.pendingLeaves;lc.style.display=d.pendingLeaves?'inline-flex':'none';}
    if(bc){bc.textContent=d.pendingBonus;bc.style.display=d.pendingBonus?'inline-flex':'none';}
    const att=d.attendance||{}, perf=d.performance||{};
    el.innerHTML=\`
<div class="stats-grid">
  <div class="stat"><div class="stat-icon">\${ICONS.emps}</div><div class="stat-val">\${d.employees?.active||0}</div><div class="stat-lbl">Active Employees</div></div>
  <div class="stat green"><div class="stat-icon">\${ICONS.att}</div><div class="stat-val">\${att.present||0}</div><div class="stat-lbl">Present Today</div></div>
  <div class="stat yellow"><div class="stat-icon">\${ICONS.att}</div><div class="stat-val">\${att.late||0}</div><div class="stat-lbl">Late Today</div></div>
  <div class="stat red"><div class="stat-icon">\${ICONS.att}</div><div class="stat-val">\${att.absent||0}</div><div class="stat-lbl">Absent Today</div></div>
  <div class="stat purple"><div class="stat-icon">\${ICONS.leave}</div><div class="stat-val">\${d.pendingLeaves}</div><div class="stat-lbl">Pending Leaves</div></div>
  <div class="stat"><div class="stat-icon">\${ICONS.pay}</div><div class="stat-val">&#8377;\${((d.payrollTotal||0)/100000).toFixed(1)}L</div><div class="stat-lbl">Monthly Payroll</div></div>
</div>
<div class="charts-row">
  <div class="card"><div class="card-hdr">Department Distribution</div><canvas id="dept-chart" height="200"></canvas></div>
  <div class="card"><div class="card-hdr">Today's Attendance</div><canvas id="att-chart" height="200"></canvas></div>
</div>
<div class="two-col">
  <div class="card">
    <div class="card-hdr">Recent Activity</div>
    \${(d.recentAudit||[]).slice(0,6).map(a=>\`
      <div style="display:flex;gap:9px;padding:7px 0;border-bottom:1px solid var(--border);font-size:12px">
        <span style="color:var(--text3);min-width:65px">\${new Date(a.CreatedAt).toLocaleTimeString('en',{hour:'2-digit',minute:'2-digit'})}</span>
        <span style="color:var(--accent);min-width:50px;font-weight:500">\${a.Actor||'?'}</span>
        <span style="color:var(--text2)">\${a.Action} \${a.Target||''}</span>
      </div>\`).join('')||'<div style="color:var(--text3);font-size:13px">No activity</div>'}
  </div>
  <div class="card">
    <div class="card-hdr">Performance Overview</div>
    <div style="text-align:center;padding:18px 0">
      <div class="stat-val" style="font-size:38px;color:var(--accent)">\${Math.round(perf.avg||0)}</div>
      <div class="stat-lbl">Average Score</div>
      <div style="display:flex;justify-content:center;gap:20px;margin-top:14px;font-size:12px">
        <div style="color:var(--green)">Best: \${perf.max||0}</div>
        <div style="color:var(--red)">Min: \${perf.min||0}</div>
      </div>
    </div>
    <button class="btn btn-primary btn-sm" style="width:100%;justify-content:center;margin-top:6px" onclick="showPage('payroll')">Generate Payroll</button>
  </div>
</div>\`;
    if(deptChart) deptChart.destroy();
    if(attChart) attChart.destroy();
    const dd=d.departments||[];
    deptChart=new Chart(document.getElementById('dept-chart'),{type:'doughnut',data:{labels:dd.map(x=>x.DeptName),datasets:[{data:dd.map(x=>x.cnt),backgroundColor:['#3b82f6','#10b981','#ef4444','#f59e0b','#8b5cf6','#06b6d4','#f97316'],borderWidth:0}]},options:{plugins:{legend:{labels:{color:'#64748b',font:{size:11}}}},cutout:'62%'}});
    attChart=new Chart(document.getElementById('att-chart'),{type:'bar',data:{labels:['Present','Late','Half-day','Absent'],datasets:[{data:[att.present||0,att.late||0,att.halfday||0,att.absent||0],backgroundColor:['#10b981','#f59e0b','#3b82f6','#ef4444'],borderRadius:5,borderWidth:0}]},options:{plugins:{legend:{display:false}},scales:{x:{ticks:{color:'#64748b'},grid:{display:false}},y:{ticks:{color:'#64748b'},grid:{color:'#f1f5f9'}}}}});
  }catch(e){el.innerHTML='<div class="alert alert-red show">'+e.message+'</div>';}
}

// EMPLOYEE DASHBOARD
async function loadEmpDash(){
  const el=document.getElementById('page-dashboard');
  el.innerHTML='<div style="color:var(--text3);padding:40px;text-align:center">Loading...</div>';
  try{
    const d=await GET('/api/dashboard/employee');
    const emp=d.employee||{}, sal=d.salary||{}, att=d.attSummary||{}, lb=d.leaveBalance||{}, ta=d.todayAtt;
    let ciSt='Not checked in', ciBadge='badge-yellow', ciBtn='<button class="btn btn-green" onclick="doCheckIn()">Check In</button>';
    if(ta){
      ciSt=ta.Status; ciBadge=ta.Status==='Present'?'badge-green':ta.Status==='Late'?'badge-yellow':'badge-red';
      ciBtn=ta.CheckOut?'<span style="color:var(--text3);font-size:13px">Checked out</span>':'<button class="btn" style="background:var(--yellow);color:#fff" onclick="doCheckOut()">Check Out</button>';
    }
    el.innerHTML=\`
<div class="checkin-box">
  <div class="live-time" id="live-time">--:--:--</div>
  <div class="live-date" id="live-date"></div>
  <div><span class="badge \${ciBadge}" style="margin-bottom:12px">\${ciSt}</span></div>
  \${ciBtn}
</div>
<div class="stats-grid">
  <div class="stat"><div class="stat-icon">\${ICONS.pay}</div><div class="stat-val">&#8377;\${(sal.net||0).toLocaleString()}</div><div class="stat-lbl">Net Salary</div></div>
  <div class="stat green"><div class="stat-icon">\${ICONS.att}</div><div class="stat-val">\${att.present||0}</div><div class="stat-lbl">Days Present</div></div>
  <div class="stat yellow"><div class="stat-icon">\${ICONS.att}</div><div class="stat-val">\${att.late||0}</div><div class="stat-lbl">Late Arrivals</div></div>
  <div class="stat purple"><div class="stat-icon">\${ICONS.perf}</div><div class="stat-val">\${parseFloat(att.ot||0).toFixed(1)}h</div><div class="stat-lbl">Overtime</div></div>
</div>
<div class="two-col">
  <div class="card">
    <div class="card-hdr">Salary Breakdown</div>
    \${sal?[\`<div class="ps-row"><span>Basic</span><span>&#8377;\${Math.round(sal.basic||0).toLocaleString()}</span></div>\`,
      \`<div class="ps-row"><span>HRA (\${sal.hraPct||0}%)</span><span style="color:var(--green)">+&#8377;\${Math.round(sal.hra||0).toLocaleString()}</span></div>\`,
      \`<div class="ps-row"><span>DA (\${sal.daPct||0}%)</span><span style="color:var(--green)">+&#8377;\${Math.round(sal.da||0).toLocaleString()}</span></div>\`,
      \`<div class="ps-row"><span>Bonus</span><span style="color:var(--green)">+&#8377;\${Math.round(sal.bonus||0).toLocaleString()}</span></div>\`,
      \`<div class="ps-row" style="color:var(--red)"><span>Deductions</span><span>-&#8377;\${Math.round(sal.totalDed||0).toLocaleString()}</span></div>\`,
      \`<div class="ps-row total"><span>Net Salary</span><span>&#8377;\${Math.round(sal.net||0).toLocaleString()}</span></div>\`].join(''):'<div style="color:var(--text3)">Not configured</div>'}
    <button class="btn btn-ghost btn-sm" style="width:100%;justify-content:center;margin-top:10px" onclick="showPage('payroll')">View Payslips</button>
  </div>
  <div class="card">
    <div class="card-hdr">Leave Balance</div>
    \${[{l:'Casual',u:lb.CasualUsed||0,t:lb.CasualTotal||12,c:'var(--accent)'},{l:'Sick',u:lb.SickUsed||0,t:lb.SickTotal||12,c:'var(--green)'},{l:'Earned',u:lb.EarnedUsed||0,t:lb.EarnedTotal||15,c:'var(--purple)'}].map(b=>\`
      <div style="margin-bottom:12px">
        <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:3px">
          <span>\${b.l}</span><span style="color:var(--text3)">\${b.u}/\${b.t} used</span>
        </div>
        <div class="bar-wrap"><div class="bar" style="width:\${Math.min(100,b.t?b.u/b.t*100:0)}%;background:\${b.c}"></div></div>
      </div>\`).join('')}
    <button class="btn btn-ghost btn-sm" style="width:100%;justify-content:center;margin-top:8px" onclick="showPage('leaves')">Apply Leave</button>
  </div>
</div>
<div class="card">
  <div class="card-hdr">Recent Leave Requests</div>
  <div class="tbl-wrap"><table>
    <thead><tr><th>Type</th><th>From</th><th>To</th><th>Days</th><th>Status</th></tr></thead>
    <tbody>\${(d.recentLeaves||[]).map(l=>\`<tr>
      <td>\${l.LeaveType}</td><td>\${l.FromDate?.slice(0,10)||''}</td><td>\${l.ToDate?.slice(0,10)||''}</td><td>\${l.Days}</td>
      <td><span class="badge \${l.Status==='Approved'?'badge-green':l.Status==='Rejected'?'badge-red':'badge-yellow'}">\${l.Status}</span></td>
    </tr>\`).join('')||'<tr><td colspan="5" style="text-align:center;color:var(--text3)">No requests</td></tr>'}
    </tbody>
  </table></div>
</div>\`;
    setupClock();
  }catch(e){el.innerHTML='<div class="alert alert-red show">'+e.message+'</div>';}
}
async function doCheckIn(){try{const r=await POST('/api/attendance/checkin',{});alert('Checked in! Status: '+r.status);loadEmpDash();}catch(e){alert(e.message);}}
async function doCheckOut(){try{const r=await POST('/api/attendance/checkout',{});alert('Checked out! Hours: '+r.hoursWorked+(parseFloat(r.overtime)>0?' (OT: '+r.overtime+'h)':''));loadEmpDash();}catch(e){alert(e.message);}}

// EMPLOYEES PAGE
let allEmps=[],empDepts=[],empRoles=[];
async function loadEmployees(){
  const el=document.getElementById('page-employees');
  el.innerHTML='<div style="color:var(--text3);padding:40px;text-align:center">Loading...</div>';
  try{
    [allEmps,empDepts,empRoles]=await Promise.all([GET('/api/employees'),GET('/api/departments'),GET('/api/roles')]);
    renderEmps(allEmps);
  }catch(e){el.innerHTML='<div class="alert alert-red show">'+e.message+'</div>';}
}
let _fs='',_fd='',_fst='';
function filterEmps(v){_fs=v;applyEmpF();}function filterEmpDept(v){_fd=v;applyEmpF();}function filterEmpSt(v){_fst=v;applyEmpF();}
function applyEmpF(){let e=allEmps;if(_fs)e=e.filter(x=>x.Name.toLowerCase().includes(_fs.toLowerCase())||x.EmpID.toLowerCase().includes(_fs.toLowerCase()));if(_fd)e=e.filter(x=>x.DeptName===_fd);if(_fst)e=e.filter(x=>(x.Status||'Active')===_fst);renderEmps(e);}
function renderEmps(emps){
  const isA=SESSION.role!=='employee';
  document.getElementById('page-employees').innerHTML=\`
<div class="toolbar">
  <div class="search-wrap"><svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg><input type="text" placeholder="Search..." oninput="filterEmps(this.value)" value="\${_fs}"></div>
  <select class="filter" onchange="filterEmpDept(this.value)"><option value="">All Depts</option>\${empDepts.map(d=>\`<option \${d.DeptName===_fd?'selected':''}>\${d.DeptName}</option>\`).join('')}</select>
  <select class="filter" onchange="filterEmpSt(this.value)"><option value="">All Status</option><option \${'Active'===_fst?'selected':''}>Active</option><option \${'Inactive'===_fst?'selected':''}>Inactive</option></select>
  \${isA?'<button class="btn btn-primary" onclick="showAddEmp()">+ Add Employee</button>':''}
</div>
<div class="tbl-wrap"><table>
  <thead><tr><th>Employee</th><th>ID</th><th>Department</th><th>Role</th><th>Basic Salary</th><th>Joining Date</th><th>Status</th>\${isA?'<th>Actions</th>':''}</tr></thead>
  <tbody>\${emps.map(e=>\`<tr>
    <td><div class="emp-cell"><div class="emp-av">\${e.Name[0]}</div>\${e.Name}</div></td>
    <td style="color:var(--accent);font-weight:600">\${e.EmpID}</td>
    <td>\${e.DeptName}</td><td>\${e.RoleName}</td>
    <td>&#8377;\${(e.BasicSalary||0).toLocaleString()}</td>
    <td>\${e.JoiningDate?.slice(0,10)||''}</td>
    <td><span class="badge \${e.Status==='Active'?'badge-green':'badge-red'}">\${e.Status||'Active'}</span></td>
    \${isA?\`<td><div style="display:flex;gap:5px;flex-wrap:wrap">
      <button class="btn btn-ghost btn-xs" onclick="showEditEmp('\${e.EmpID}')">Edit</button>
      <button class="btn btn-ghost btn-xs" onclick="showSalComp('\${e.EmpID}','\${e.Name}')">Salary</button>
      <button class="btn btn-ghost btn-xs" onclick="addPerf('\${e.EmpID}','\${e.Name}')">Review</button>
      <button class="btn btn-red btn-xs" onclick="delEmp('\${e.EmpID}','\${e.Name}')">Remove</button>
      <button class="btn btn-ghost btn-xs" onclick="resetPw('\${e.EmpID}')">Reset PW</button>
    </div></td>\`:''}
  </tr>\`).join('')||'<tr><td colspan="8" style="text-align:center;color:var(--text3)">No employees</td></tr>'}
  </tbody>
</table></div>\`;
}
function showAddEmp(){
  openModal('Add Employee',\`<div class="form-grid">
    <div class="fg"><label>Employee ID *</label><input id="f-id" placeholder="EMP041" style="text-transform:uppercase"></div>
    <div class="fg"><label>Full Name *</label><input id="f-name" placeholder="Full Name"></div>
    <div class="fg"><label>Department *</label><select id="f-dept">\${empDepts.map(d=>\`<option value="\${d.DeptID}">\${d.DeptName}</option>\`).join('')}</select></div>
    <div class="fg"><label>Role *</label><select id="f-role">\${empRoles.map(r=>\`<option value="\${r.RoleID}">\${r.RoleName}</option>\`).join('')}</select></div>
    <div class="fg"><label>Basic Salary *</label><input id="f-sal" type="number" placeholder="50000"></div>
    <div class="fg"><label>Joining Date *</label><input id="f-join" type="date"></div>
    <div class="fg"><label>Email</label><input id="f-email" type="email"></div>
    <div class="fg"><label>Phone</label><input id="f-phone" placeholder="9876543210"></div>
  </div><div id="add-a"></div>\`,[{label:'Add Employee',cls:'btn-primary',action:async()=>{
    const id=document.getElementById('f-id').value.trim().toUpperCase();
    const body={EmpID:id,Name:document.getElementById('f-name').value,DeptID:document.getElementById('f-dept').value,RoleID:document.getElementById('f-role').value,BasicSalary:document.getElementById('f-sal').value,JoiningDate:document.getElementById('f-join').value,Email:document.getElementById('f-email').value,Phone:document.getElementById('f-phone').value};
    try{await POST('/api/employees',body);closeModal();loadEmployees();}catch(e){showAlert('add-a',e.message,'red');}
  }}]);
}
async function showEditEmp(id){
  const emp=allEmps.find(e=>e.EmpID===id);
  openModal('Edit - '+id,\`<div class="form-grid">
    <div class="fg"><label>Full Name</label><input id="e-name" value="\${emp.Name||''}"></div>
    <div class="fg"><label>Department</label><select id="e-dept">\${empDepts.map(d=>\`<option value="\${d.DeptID}" \${d.DeptID==emp.DeptID?'selected':''}>\${d.DeptName}</option>\`).join('')}</select></div>
    <div class="fg"><label>Role</label><select id="e-role">\${empRoles.map(r=>\`<option value="\${r.RoleID}" \${r.RoleID==emp.RoleID?'selected':''}>\${r.RoleName}</option>\`).join('')}</select></div>
    <div class="fg"><label>Basic Salary</label><input id="e-sal" type="number" value="\${emp.BasicSalary||0}"></div>
    <div class="fg"><label>Joining Date</label><input id="e-join" type="date" value="\${emp.JoiningDate?.slice(0,10)||''}"></div>
    <div class="fg"><label>Email</label><input id="e-email" value="\${emp.Email||''}"></div>
    <div class="fg"><label>Phone</label><input id="e-phone" value="\${emp.Phone||''}"></div>
    <div class="fg"><label>Status</label><select id="e-st"><option \${emp.Status==='Active'?'selected':''}>Active</option><option \${emp.Status==='Inactive'?'selected':''}>Inactive</option></select></div>
  </div><div id="edit-a"></div>\`,[{label:'Save',cls:'btn-primary',action:async()=>{
    const body={Name:document.getElementById('e-name').value,DeptID:document.getElementById('e-dept').value,RoleID:document.getElementById('e-role').value,BasicSalary:document.getElementById('e-sal').value,JoiningDate:document.getElementById('e-join').value,Email:document.getElementById('e-email').value,Phone:document.getElementById('e-phone').value,Status:document.getElementById('e-st').value};
    try{await PUT('/api/employees/'+id,body);closeModal();loadEmployees();}catch(e){showAlert('edit-a',e.message,'red');}
  }}]);
}
async function delEmp(id,name){if(!confirm('Remove '+name+'?'))return;try{await DEL('/api/employees/'+id);loadEmployees();}catch(e){alert(e.message);}}
async function resetPw(id){if(!confirm('Reset password for '+id+' to their EmpID?'))return;try{await POST('/api/employees/'+id+'/reset-password',{});alert('Password reset to '+id);}catch(e){alert(e.message);}}
async function showSalComp(id,name){
  const sc=await GET('/api/salary-components/'+id).catch(()=>({}));
  openModal('Salary - '+name,\`<div class="form-grid">
    <div class="fg"><label>Basic Salary</label><input id="sc-b" type="number" value="\${sc?.BasicSalary||0}" oninput="calcPrev()"></div>
    <div class="fg"><label>HRA %</label><input id="sc-h" type="number" value="\${sc?.HRA_Pct||20}" oninput="calcPrev()"></div>
    <div class="fg"><label>DA %</label><input id="sc-d" type="number" value="\${sc?.DA_Pct||10}" oninput="calcPrev()"></div>
    <div class="fg"><label>PF %</label><input id="sc-pf" type="number" value="\${sc?.PF_Pct||12}" oninput="calcPrev()"></div>
    <div class="fg"><label>Tax %</label><input id="sc-tx" type="number" value="\${sc?.Tax_Pct||10}" oninput="calcPrev()"></div>
  </div><div id="sc-prev" style="margin-top:12px"></div><div id="sc-a"></div>\`,[{label:'Save',cls:'btn-primary',action:async()=>{
    const body={BasicSalary:document.getElementById('sc-b').value,HRA_Pct:document.getElementById('sc-h').value,DA_Pct:document.getElementById('sc-d').value,PF_Pct:document.getElementById('sc-pf').value,Tax_Pct:document.getElementById('sc-tx').value};
    try{await PUT('/api/salary-components/'+id,body);closeModal();showPage('employees');}catch(e){showAlert('sc-a',e.message,'red');}
  }}]);
  calcPrev();
}
function calcPrev(){
  const b=parseFloat(document.getElementById('sc-b')?.value||0),h=parseFloat(document.getElementById('sc-h')?.value||0),d=parseFloat(document.getElementById('sc-d')?.value||0),pf=parseFloat(document.getElementById('sc-pf')?.value||0),tx=parseFloat(document.getElementById('sc-tx')?.value||0);
  const hra=b*h/100,da=b*d/100,gross=b+hra+da,pfA=b*pf/100,txA=gross*tx/100,net=gross-pfA-txA;
  const el=document.getElementById('sc-prev');
  if(el) el.innerHTML=\`<div class="ps-row"><span>Gross</span><span>&#8377;\${Math.round(gross).toLocaleString()}</span></div><div class="ps-row" style="color:var(--red)"><span>PF + Tax</span><span>-&#8377;\${Math.round(pfA+txA).toLocaleString()}</span></div><div class="ps-row total"><span>Est. Net</span><span>&#8377;\${Math.round(net).toLocaleString()}</span></div>\`;
}

// ATTENDANCE
async function loadAttendance(){
  const el=document.getElementById('page-attendance');
  el.innerHTML='<div style="color:var(--text3);padding:40px;text-align:center">Loading...</div>';
  const isEmp=SESSION.role==='employee';
  try{
    const now=new Date();
    const params=isEmp?\`?month=\${now.getMonth()+1}&year=\${now.getFullYear()}\`:'';
    const data=await GET('/api/attendance'+params);
    el.innerHTML=\`
\${isEmp?'':\`<div class="toolbar"><button class="btn btn-ghost" onclick="loadAttendance()">Refresh</button></div>\`}
<div class="tbl-wrap"><table>
  <thead><tr>\${isEmp?'<th>Date</th>':'<th>Employee</th><th>Dept</th>'}<th>Check In</th><th>Check Out</th><th>Status</th><th>Overtime</th></tr></thead>
  <tbody>\${data.map(a=>\`<tr>
    \${isEmp?\`<td>\${new Date(a.CheckIn).toLocaleDateString('en-IN',{weekday:'short',day:'numeric',month:'short'})}</td>\`:\`<td><div class="emp-cell"><div class="emp-av">\${(a.Name||'?')[0]}</div>\${a.Name}<br><small style="color:var(--text3)">\${a.EmpID}</small></div></td><td>\${a.DeptName||''}</td>\`}
    <td>\${a.CheckIn?new Date(a.CheckIn).toLocaleTimeString('en',{hour:'2-digit',minute:'2-digit'}):'--'}</td>
    <td>\${a.CheckOut?new Date(a.CheckOut).toLocaleTimeString('en',{hour:'2-digit',minute:'2-digit'}):'--'}</td>
    <td><span class="badge \${a.Status==='Present'?'badge-green':a.Status==='Late'?'badge-yellow':a.Status==='Half-day'?'badge-blue':'badge-red'}">\${a.Status}</span></td>
    <td>\${parseFloat(a.OvertimeHours||0).toFixed(1)}h</td>
  </tr>\`).join('')||'<tr><td colspan="6" style="text-align:center;color:var(--text3)">No records</td></tr>'}
  </tbody>
</table></div>\`;
  }catch(e){el.innerHTML='<div class="alert alert-red show">'+e.message+'</div>';}
}

// LEAVES
async function loadLeaves(){
  const el=document.getElementById('page-leaves');
  el.innerHTML='<div style="color:var(--text3);padding:40px;text-align:center">Loading...</div>';
  const isEmp=SESSION.role==='employee';
  try{
    const [data,bal]=await Promise.all([GET('/api/leaves'),isEmp?GET('/api/leaves/balance'):Promise.resolve(null)]);
    el.innerHTML=\`
\${isEmp?\`<div class="stats-grid" style="margin-bottom:14px">
  \${[{l:'Casual',u:bal?.CasualUsed||0,t:bal?.CasualTotal||12,c:'blue'},{l:'Sick',u:bal?.SickUsed||0,t:bal?.SickTotal||12,c:'green'},{l:'Earned',u:bal?.EarnedUsed||0,t:bal?.EarnedTotal||15,c:'purple'}].map(b=>\`<div class="stat \${b.c}"><div class="stat-val">\${b.t-b.u}</div><div class="stat-lbl">\${b.l} Remaining</div></div>\`).join('')}
</div>
<div class="card" style="margin-bottom:14px">
  <div class="card-hdr">Apply for Leave</div>
  <div class="form-grid">
    <div class="fg"><label>Type</label><select id="lv-t"><option>Casual</option><option>Sick</option><option>Earned</option><option>Unpaid</option></select></div>
    <div class="fg"><label>From</label><input id="lv-f" type="date"></div>
    <div class="fg"><label>To</label><input id="lv-to" type="date" onchange="calcDays()"></div>
    <div class="fg"><label>Days</label><input id="lv-d" type="number" min="1" placeholder="1"></div>
  </div>
  <div class="fg" style="margin-top:10px"><label>Reason</label><textarea id="lv-r" placeholder="Reason..."></textarea></div>
  <div id="lv-a" style="margin-top:8px"></div>
  <div class="form-actions"><button class="btn btn-primary" onclick="submitLeave()">Submit</button></div>
</div>\`:\`<div class="toolbar"><select class="filter" onchange="filterLeaves(this.value)"><option value="">All Status</option><option>Pending</option><option>Approved</option><option>Rejected</option></select><button class="btn btn-ghost" onclick="loadLeaves()">Refresh</button></div>\`}
<div class="tbl-wrap"><table>
  <thead><tr>\${isEmp?'':'<th>Employee</th><th>Dept</th>'}<th>Type</th><th>From</th><th>To</th><th>Days</th><th>Reason</th><th>Status</th>\${!isEmp?'<th>Action</th>':''}</tr></thead>
  <tbody id="lv-tbody">\${renderLvRows(data,isEmp)}</tbody>
</table></div>\`;
  }catch(e){el.innerHTML='<div class="alert alert-red show">'+e.message+'</div>';}
}
function renderLvRows(data,isEmp){
  return data.map(l=>\`<tr>
    \${isEmp?'':\`<td><div class="emp-cell"><div class="emp-av">\${(l.Name||'?')[0]}</div>\${l.Name}</div></td><td>\${l.DeptName||''}</td>\`}
    <td>\${l.LeaveType}</td><td>\${l.FromDate?.slice(0,10)||''}</td><td>\${l.ToDate?.slice(0,10)||''}</td><td>\${l.Days}</td>
    <td style="max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">\${l.Reason||'--'}</td>
    <td><span class="badge \${l.Status==='Approved'?'badge-green':l.Status==='Rejected'?'badge-red':'badge-yellow'}">\${l.Status}</span></td>
    \${!isEmp&&l.Status==='Pending'?\`<td><div style="display:flex;gap:5px"><button class="btn btn-green btn-xs" onclick="reviewLeave(\${l.LeaveID},'Approved')">Approve</button><button class="btn btn-red btn-xs" onclick="reviewLeave(\${l.LeaveID},'Rejected')">Reject</button></div></td>\`:(!isEmp?'<td>--</td>':'')}
  </tr>\`).join('')||'<tr><td colspan="9" style="text-align:center;color:var(--text3)">No records</td></tr>';
}
function calcDays(){const f=document.getElementById('lv-f')?.value,t=document.getElementById('lv-to')?.value;if(f&&t){const d=Math.ceil((new Date(t)-new Date(f))/864e5)+1;if(d>0)document.getElementById('lv-d').value=d;}}
async function submitLeave(){
  const body={LeaveType:document.getElementById('lv-t').value,FromDate:document.getElementById('lv-f').value,ToDate:document.getElementById('lv-to').value,Days:document.getElementById('lv-d').value,Reason:document.getElementById('lv-r').value};
  if(!body.FromDate||!body.ToDate||!body.Days)return showAlert('lv-a','Fill required fields','red');
  try{await POST('/api/leaves',body);showAlert('lv-a','Leave submitted!','green');setTimeout(loadLeaves,1500);}catch(e){showAlert('lv-a',e.message,'red');}
}
async function reviewLeave(id,status){
  const note=status==='Rejected'?prompt('Rejection reason (optional):'):null;
  try{await PUT('/api/leaves/'+id+'/review',{status,adminNote:note});loadLeaves();}catch(e){alert(e.message);}
}
async function filterLeaves(st){
  try{const data=await GET('/api/leaves'+(st?'?status='+st:''));const tb=document.getElementById('lv-tbody');if(tb)tb.innerHTML=renderLvRows(data,false);}catch(e){console.error(e);}
}

// BONUS
async function loadBonus(){
  const el=document.getElementById('page-bonus');
  el.innerHTML='<div style="color:var(--text3);padding:40px;text-align:center">Loading...</div>';
  const isEmp=SESSION.role==='employee';
  try{
    const data=await GET('/api/bonus');
    el.innerHTML=\`
\${isEmp?\`<div class="card" style="margin-bottom:14px">
  <div class="card-hdr">Request Bonus</div>
  <div class="form-grid">
    <div class="fg"><label>Amount (Rs.)</label><input id="bn-a" type="number" placeholder="5000"></div>
    <div class="fg" style="grid-column:1/-1"><label>Reason</label><textarea id="bn-r" placeholder="Reason..."></textarea></div>
  </div>
  <div id="bn-alert" style="margin-top:8px"></div>
  <div class="form-actions"><button class="btn btn-primary" onclick="submitBonus()">Submit</button></div>
</div>\`:'<div class="toolbar"><button class="btn btn-ghost" onclick="loadBonus()">Refresh</button></div>'}
<div class="tbl-wrap"><table>
  <thead><tr>\${isEmp?'':'<th>Employee</th><th>Dept</th>'}<th>Amount</th><th>Reason</th><th>Date</th><th>Status</th>\${!isEmp?'<th>Action</th>':''}</tr></thead>
  <tbody>\${data.map(b=>\`<tr>
    \${isEmp?'':\`<td><div class="emp-cell"><div class="emp-av">\${(b.Name||'?')[0]}</div>\${b.Name}</div></td><td>\${b.DeptName||''}</td>\`}
    <td style="color:var(--green);font-weight:600">&#8377;\${parseFloat(b.Amount).toLocaleString()}</td>
    <td style="max-width:200px;overflow:hidden;text-overflow:ellipsis">\${b.Reason||'--'}</td>
    <td>\${b.RequestDate?.slice(0,10)||''}</td>
    <td><span class="badge \${b.Status==='Approved'?'badge-green':b.Status==='Rejected'?'badge-red':'badge-yellow'}">\${b.Status}</span></td>
    \${!isEmp&&b.Status==='Pending'?\`<td><div style="display:flex;gap:5px"><button class="btn btn-green btn-xs" onclick="reviewBonus(\${b.BonusID},'Approved')">Approve</button><button class="btn btn-red btn-xs" onclick="reviewBonus(\${b.BonusID},'Rejected')">Reject</button></div></td>\`:(!isEmp?'<td>--</td>':'')}
  </tr>\`).join('')||'<tr><td colspan="7" style="text-align:center;color:var(--text3)">No requests</td></tr>'}
  </tbody>
</table></div>\`;
  }catch(e){el.innerHTML='<div class="alert alert-red show">'+e.message+'</div>';}
}
async function submitBonus(){
  const body={Amount:document.getElementById('bn-a').value,Reason:document.getElementById('bn-r').value};
  if(!body.Amount||body.Amount<=0)return showAlert('bn-alert','Enter valid amount','red');
  try{await POST('/api/bonus',body);showAlert('bn-alert','Request submitted!','green');setTimeout(loadBonus,1500);}catch(e){showAlert('bn-alert',e.message,'red');}
}
async function reviewBonus(id,status){
  const note=status==='Rejected'?prompt('Rejection reason:'):null;
  try{await PUT('/api/bonus/'+id+'/review',{status,adminNote:note});loadBonus();}catch(e){alert(e.message);}
}

// PAYROLL
async function loadPayroll(){
  const el=document.getElementById('page-payroll');
  el.innerHTML='<div style="color:var(--text3);padding:40px;text-align:center">Loading...</div>';
  const isA=SESSION.role!=='employee';
  const now=new Date();
  try{
    const data=await GET('/api/payroll');
    el.innerHTML=\`
\${isA?\`<div class="card" style="margin-bottom:14px">
  <div class="card-hdr">Generate Payroll</div>
  <div class="form-grid" style="grid-template-columns:1fr 1fr auto">
    <div class="fg"><label>Month</label><select id="pr-m">\${[1,2,3,4,5,6,7,8,9,10,11,12].map(m=>\`<option value="\${m}" \${m===now.getMonth()+1?'selected':''}>\${new Date(2024,m-1).toLocaleString('en',{month:'long'})}</option>\`).join('')}</select></div>
    <div class="fg"><label>Year</label><input id="pr-y" type="number" value="\${now.getFullYear()}"></div>
    <div class="fg" style="justify-content:flex-end;padding-top:18px"><button class="btn btn-primary" onclick="genPayroll()">Generate</button></div>
  </div>
  <div id="pr-a" style="margin-top:8px"></div>
</div>\`:''}
<div class="tbl-wrap"><table>
  <thead><tr>\${isA?'<th>Employee</th><th>Dept</th>':''}<th>Period</th><th>Basic</th><th>Gross</th><th>Deductions</th><th>Net Salary</th><th>Days</th><th></th></tr></thead>
  <tbody>\${data.map(p=>\`<tr>
    \${isA?\`<td><div class="emp-cell"><div class="emp-av">\${(p.Name||'?')[0]}</div>\${p.Name}</div></td><td>\${p.DeptName||''}</td>\`:''}
    <td>\${new Date(2024,parseInt(p.Month)-1).toLocaleString('en',{month:'short'})} \${p.Year}</td>
    <td>&#8377;\${(p.BasicSalary||0).toLocaleString()}</td>
    <td>&#8377;\${(p.GrossSalary||0).toLocaleString()}</td>
    <td style="color:var(--red)">-&#8377;\${(p.TotalDeduct||0).toLocaleString()}</td>
    <td style="color:var(--green);font-weight:700">&#8377;\${(p.NetSalary||0).toLocaleString()}</td>
    <td>\${p.PresentDays||0}/\${p.WorkingDays||26}</td>
    <td><button class="btn btn-ghost btn-xs" onclick="viewPayslip('\${p.EmpID}',\${p.Month},\${p.Year})">Payslip</button></td>
  </tr>\`).join('')||'<tr><td colspan="9" style="text-align:center;color:var(--text3)">No payroll records. Generate first.</td></tr>'}
  </tbody>
</table></div>\`;
  }catch(e){el.innerHTML='<div class="alert alert-red show">'+e.message+'</div>';}
}
async function genPayroll(){
  showAlert('pr-a','Generating...','blue');
  try{const r=await POST('/api/payroll/generate',{month:document.getElementById('pr-m').value,year:document.getElementById('pr-y').value});showAlert('pr-a',\`Done! Generated for \${r.generated} employees.\`,'green');setTimeout(loadPayroll,1000);}
  catch(e){showAlert('pr-a',e.message,'red');}
}
async function viewPayslip(empId,month,year){
  try{
    const [sal,emp]=await Promise.all([GET(\`/api/salary/\${empId}?month=\${month}&year=\${year}\`),GET('/api/employees/'+empId)]);
    const mn=new Date(2024,month-1).toLocaleString('en',{month:'long'});
    openModal(\`Payslip - \${emp.Name} - \${mn} \${year}\`,\`
<div class="payslip" id="pp">
  <div class="payslip-hdr">
    <div><div class="payslip-co">EMS<span>&middot;</span>HR</div><div style="font-size:11px;color:var(--text3)">Enterprise HR Platform</div></div>
    <div style="text-align:right;font-size:12px;color:var(--text2)"><div style="font-weight:700;font-size:14px">PAYSLIP</div><div>\${mn} \${year}</div></div>
  </div>
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:14px;font-size:12.5px">
    <div><div style="font-size:10px;text-transform:uppercase;letter-spacing:1px;color:var(--text3);margin-bottom:5px">Employee</div><div style="font-weight:600">\${emp.Name}</div><div style="color:var(--text3)">\${emp.EmpID} &middot; \${emp.DeptName}</div><div style="color:var(--text3)">\${emp.RoleName}</div></div>
    <div><div style="font-size:10px;text-transform:uppercase;letter-spacing:1px;color:var(--text3);margin-bottom:5px">Period</div><div style="font-weight:600">\${mn} \${year}</div><div style="color:var(--text3)">Working Days: \${sal.workDays||26}</div><div style="color:var(--text3)">Present: \${sal.present||0}</div></div>
  </div>
  <div class="ps-sec">Earnings</div>
  <div class="ps-row"><span>Basic Salary</span><span>&#8377;\${Math.round(sal.basic||0).toLocaleString()}</span></div>
  <div class="ps-row"><span>HRA (\${sal.hraPct||0}%)</span><span>&#8377;\${Math.round(sal.hra||0).toLocaleString()}</span></div>
  <div class="ps-row"><span>DA (\${sal.daPct||0}%)</span><span>&#8377;\${Math.round(sal.da||0).toLocaleString()}</span></div>
  <div class="ps-row"><span>Bonus</span><span>&#8377;\${Math.round(sal.bonus||0).toLocaleString()}</span></div>
  <div class="ps-row"><span>Overtime Pay</span><span>&#8377;\${Math.round(sal.otPay||0).toLocaleString()}</span></div>
  <div class="ps-sec">Deductions</div>
  <div class="ps-row" style="color:var(--red)"><span>PF (\${sal.pfPct||0}%)</span><span>-&#8377;\${Math.round(sal.pf||0).toLocaleString()}</span></div>
  <div class="ps-row" style="color:var(--red)"><span>Tax (\${sal.taxPct||0}%)</span><span>-&#8377;\${Math.round(sal.tax||0).toLocaleString()}</span></div>
  <div class="ps-row" style="color:var(--red)"><span>Absent Deduction</span><span>-&#8377;\${Math.round(sal.absentDed||0).toLocaleString()}</span></div>
  <div class="ps-row" style="color:var(--red)"><span>Late Penalty</span><span>-&#8377;\${Math.round(sal.latePen||0).toLocaleString()}</span></div>
  <div class="ps-row total"><span>NET SALARY</span><span>&#8377;\${Math.round(sal.net||0).toLocaleString()}</span></div>
  <div style="margin-top:18px;padding-top:10px;border-top:1px solid var(--border);font-size:11px;color:var(--text3);text-align:center">Generated by EMS HR Platform &middot; \${new Date().toLocaleDateString('en-IN')}</div>
</div>\`,[{label:'Print / Save PDF',cls:'btn-primary',action:()=>window.print()}]);
  }catch(e){alert(e.message);}
}

// PERFORMANCE
async function loadPerformance(){
  const el=document.getElementById('page-performance');
  el.innerHTML='<div style="color:var(--text3);padding:40px;text-align:center">Loading...</div>';
  const isA=SESSION.role!=='employee';
  try{
    const data=await GET('/api/performance');
    el.innerHTML=\`
\${isA?'<div class="toolbar"><button class="btn btn-primary" onclick="addPerf()">+ Add Review</button></div>':''}
<div class="tbl-wrap"><table>
  <thead><tr>\${isA?'<th>Employee</th><th>Dept</th>':''}<th>Period</th><th>Score</th><th>Category</th><th>Comments</th><th>Date</th></tr></thead>
  <tbody>\${data.map(p=>{
    const cat=p.Score>=90?'Excellent':p.Score>=75?'Good':p.Score>=60?'Average':'Needs Improvement';
    const sc=p.Score>=90?'score-ex':p.Score>=75?'score-gd':p.Score>=60?'score-av':'score-po';
    return \`<tr>
      \${isA?\`<td><div class="emp-cell"><div class="emp-av">\${(p.Name||'?')[0]}</div>\${p.Name}</div></td><td>\${p.DeptName||''}</td>\`:''}
      <td>\${p.Period||'--'}</td>
      <td><div class="score-circle \${sc}">\${p.Score}</div></td>
      <td><span class="badge \${p.Score>=75?'badge-green':'badge-yellow'}">\${cat}</span></td>
      <td style="max-width:200px;font-size:12px;color:var(--text3)">\${p.Comments||'--'}</td>
      <td>\${p.CreatedAt?.slice(0,10)||''}</td>
    </tr>\`;
  }).join('')||'<tr><td colspan="7" style="text-align:center;color:var(--text3)">No reviews</td></tr>'}
  </tbody>
</table></div>\`;
  }catch(e){el.innerHTML='<div class="alert alert-red show">'+e.message+'</div>';}
}
async function addPerf(empId,name){
  const emps=empId?[{EmpID:empId,Name:name}]:(allEmps.length?allEmps:await GET('/api/employees'));
  openModal('Add Performance Review',\`<div class="form-grid">
    <div class="fg"><label>Employee</label><select id="pf-e">\${emps.map(e=>\`<option value="\${e.EmpID}" \${e.EmpID===empId?'selected':''}>\${e.Name} (\${e.EmpID})</option>\`).join('')}</select></div>
    <div class="fg"><label>Period</label><input id="pf-p" placeholder="Q1 2026"></div>
    <div class="fg"><label>Score (1-100)</label><input id="pf-s" type="number" min="1" max="100" placeholder="75"></div>
    <div class="fg"><label>Category</label><select id="pf-c"><option>Technical</option><option>Leadership</option><option>Communication</option><option>Productivity</option><option>Overall</option></select></div>
    <div class="fg" style="grid-column:1/-1"><label>Comments</label><textarea id="pf-cm" placeholder="Feedback..."></textarea></div>
  </div><div id="pf-a"></div>\`,[{label:'Submit',cls:'btn-primary',action:async()=>{
    const body={EmpID:document.getElementById('pf-e').value,Period:document.getElementById('pf-p').value,Score:document.getElementById('pf-s').value,Category:document.getElementById('pf-c').value,Comments:document.getElementById('pf-cm').value};
    try{await POST('/api/performance',body);closeModal();loadPerformance();}catch(e){showAlert('pf-a',e.message,'red');}
  }}]);
}

// AUDIT
async function loadAudit(){
  const el=document.getElementById('page-audit');
  el.innerHTML='<div style="color:var(--text3);padding:40px;text-align:center">Loading...</div>';
  try{
    const data=await GET('/api/audit');
    el.innerHTML=\`<div class="tbl-wrap"><table>
      <thead><tr><th>Time</th><th>Actor</th><th>Action</th><th>Target</th><th>Detail</th></tr></thead>
      <tbody>\${data.map(a=>\`<tr>
        <td style="white-space:nowrap;font-size:11px">\${new Date(a.CreatedAt).toLocaleString('en-IN',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'})}</td>
        <td style="color:var(--accent);font-weight:500">\${a.Actor||'--'}</td>
        <td>\${a.Action||'--'}</td>
        <td style="color:var(--text3)">\${a.Target||'--'}</td>
        <td style="font-size:12px;color:var(--text2)">\${a.Detail||'--'}</td>
      </tr>\`).join('')||'<tr><td colspan="5" style="text-align:center;color:var(--text3)">No records</td></tr>'}
      </tbody>
    </table></div>\`;
  }catch(e){el.innerHTML='<div class="alert alert-red show">'+e.message+'</div>';}
}

// PROFILE
async function loadProfile(){
  const el=document.getElementById('page-profile');
  const s=SESSION;
  if(s.role==='employee'){
    try{
      const emp=await GET('/api/employees/'+s.empId);
      el.innerHTML=\`<div class="two-col">
  <div class="card">
    <div class="card-hdr">My Profile</div>
    <div style="display:flex;align-items:center;gap:14px;margin-bottom:18px">
      <div style="width:56px;height:56px;border-radius:50%;background:linear-gradient(135deg,var(--accent),var(--purple));display:flex;align-items:center;justify-content:center;font-size:22px;font-weight:700;color:#fff">\${(emp.Name||'?')[0]}</div>
      <div><div style="font-size:17px;font-weight:600">\${emp.Name}</div><div style="color:var(--text3);font-size:12px">\${emp.EmpID} &middot; \${emp.RoleName}</div></div>
    </div>
    \${[['Department',emp.DeptName],['Email',emp.Email||'--'],['Phone',emp.Phone||'--'],['Joining Date',emp.JoiningDate?.slice(0,10)||'--'],['Status',emp.Status||'Active']].map(([l,v])=>\`<div class="ps-row"><span style="color:var(--text3)">\${l}</span><span>\${v}</span></div>\`).join('')}
  </div>
  <div class="card">
    <div class="card-hdr">Change Password</div>
    \${s.mustChange?'<div class="alert alert-blue show" style="margin-bottom:12px">Please change your default password.</div>':''}
    <div class="fg"><label>New Password</label><input id="cp1" type="password" placeholder="Min 4 characters"></div>
    <div class="fg" style="margin-top:10px"><label>Confirm Password</label><input id="cp2" type="password" placeholder="Confirm"></div>
    <div id="cp-a" style="margin-top:8px"></div>
    <div class="form-actions"><button class="btn btn-primary" onclick="changePw()">Update Password</button></div>
  </div>
</div>\`;
    }catch(e){el.innerHTML='<div class="alert alert-red show">'+e.message+'</div>';}
  } else {
    el.innerHTML=\`<div class="card" style="max-width:380px">
  <div class="card-hdr">Change Password</div>
  <div class="fg"><label>New Password</label><input id="cp1" type="password" placeholder="New password"></div>
  <div class="fg" style="margin-top:10px"><label>Confirm</label><input id="cp2" type="password" placeholder="Confirm"></div>
  <div id="cp-a" style="margin-top:8px"></div>
  <div class="form-actions"><button class="btn btn-primary" onclick="changePw()">Update</button></div>
</div>\`;
  }
}
async function changePw(){
  const p1=document.getElementById('cp1')?.value, p2=document.getElementById('cp2')?.value;
  if(!p1||p1.length<4)return showAlert('cp-a','Min 4 characters','red');
  if(p1!==p2)return showAlert('cp-a','Passwords do not match','red');
  try{await POST('/api/auth/change-password',{newPassword:p1});SESSION.mustChange=false;localStorage.setItem('ems_sess',JSON.stringify(SESSION));showAlert('cp-a','Password updated!','green');}
  catch(e){showAlert('cp-a',e.message,'red');}
}
function showChangePwModal(){
  openModal('Change Default Password',\`<div class="alert alert-blue show" style="margin-bottom:12px">Your default password is your Employee ID. Please set a new one.</div>
<div class="fg"><label>New Password</label><input id="m-p1" type="password" placeholder="Min 4 chars"></div>
<div class="fg" style="margin-top:10px"><label>Confirm</label><input id="m-p2" type="password" placeholder="Confirm"></div>
<div id="m-pa"></div>\`,[{label:'Set Password',cls:'btn-primary',action:async()=>{
    const p1=document.getElementById('m-p1')?.value,p2=document.getElementById('m-p2')?.value;
    if(!p1||p1.length<4)return showAlert('m-pa','Min 4 characters','red');
    if(p1!==p2)return showAlert('m-pa','Passwords do not match','red');
    try{await POST('/api/auth/change-password',{newPassword:p1});SESSION.mustChange=false;localStorage.setItem('ems_sess',JSON.stringify(SESSION));closeModal();}
    catch(e){showAlert('m-pa',e.message,'red');}
  }}]);
}

// NOTIFICATIONS
async function loadNotifs(){
  if(SESSION.role!=='employee')return;
  try{
    const data=await GET('/api/notifications');
    const unread=data.filter(n=>!n.IsRead).length;
    const dot=document.getElementById('notif-cnt');
    if(dot){dot.textContent=unread;dot.style.display=unread?'flex':'none';}
    const list=document.getElementById('notif-list');
    if(list)list.innerHTML=data.length?data.map(n=>\`<div class="notif-item \${!n.IsRead?'unread':''}">
      <div style="font-size:10px;text-transform:uppercase;color:var(--accent);margin-bottom:1px">\${n.Type}</div>
      <div>\${n.Message}</div>
      <div class="notif-time">\${new Date(n.CreatedAt).toLocaleString('en-IN',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'})}</div>
    </div>\`).join(''):'<div style="padding:14px;text-align:center;color:var(--text3)">No notifications</div>';
  }catch(_){}
}
function toggleNotif(){const p=document.getElementById('notif-panel');p.classList.toggle('open');if(p.classList.contains('open'))loadNotifs();}
async function markRead(){await POST('/api/notifications/read',{}).catch(()=>{});loadNotifs();}
function startPoll(){if(pollInt)clearInterval(pollInt);pollInt=setInterval(()=>{loadNotifs();if(curPage==='dashboard')loadEmpDash();},30000);}

// HELPERS
function openModal(title,body,btns=[]){
  document.getElementById('modal-ttl').textContent=title;
  document.getElementById('modal-body').innerHTML=body;
  const ftr=document.getElementById('modal-ftr');
  if(btns.length){ftr.style.display='flex';ftr.innerHTML='<button class="btn btn-ghost" onclick="closeModal()">Cancel</button>'+btns.map(b=>\`<button class="btn \${b.cls||'btn-primary'}" onclick="(\${b.action.toString()})()">\${b.label}</button>\`).join('');}
  else ftr.style.display='none';
  document.getElementById('overlay').classList.add('open');
}
function closeModal(){document.getElementById('overlay').classList.remove('open');}
function showAlert(id,msg,type='blue'){
  const el=document.getElementById(id); if(!el)return;
  el.className='alert alert-'+type+' show'; el.textContent=msg;
  setTimeout(()=>el.classList.remove('show'),5000);
}
function setupClock(){
  if(clockInt)clearInterval(clockInt);
  function tick(){
    const n=new Date();
    const t=document.getElementById('live-time'),d=document.getElementById('live-date');
    if(t)t.textContent=n.toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit',second:'2-digit'});
    if(d)d.textContent=n.toLocaleDateString('en-IN',{weekday:'long',day:'numeric',month:'long',year:'numeric'});
  }
  tick(); clockInt=setInterval(tick,1000);
}
function toggleSidebar(){document.getElementById('sidebar').classList.toggle('collapsed');}
document.addEventListener('click',e=>{
  const p=document.getElementById('notif-panel'),b=document.getElementById('notif-btn');
  if(p&&!p.contains(e.target)&&!b?.contains(e.target))p.classList.remove('open');
});

// BOOT
(async()=>{
  if(TOKEN&&SESSION){
    try{await GET('/api/auth/me');initApp();}
    catch(_){TOKEN='';SESSION=null;localStorage.removeItem('ems_tok');localStorage.removeItem('ems_sess');}
  }
})();
</script>
</body>
</html>`;}

// ======================================================================
//  START
// ======================================================================
setupDB().then(()=>{
  app.listen(4000,()=>console.log('[OK] EMS Enterprise -> http://localhost:4000'));
});
