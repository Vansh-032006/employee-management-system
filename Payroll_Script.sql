USE master;
GO

IF EXISTS (SELECT name FROM sys.databases WHERE name = 'EMS_DB')
BEGIN
  ALTER DATABASE EMS_DB SET SINGLE_USER WITH ROLLBACK IMMEDIATE;
  DROP DATABASE EMS_DB;
END
GO

CREATE DATABASE EMS_DB;
GO

USE EMS_DB;
GO

-- Users Table
CREATE TABLE Users (
  UserID INT IDENTITY(1,1) PRIMARY KEY,
  Username NVARCHAR(50) UNIQUE NOT NULL,
  Password NVARCHAR(100) NOT NULL,
  Role NVARCHAR(10) NOT NULL DEFAULT 'user',
  CreatedAt DATETIME DEFAULT GETDATE()
);

-- Departments Table
CREATE TABLE Departments (
  DeptID INT IDENTITY(1,1) PRIMARY KEY,
  DeptName NVARCHAR(50) UNIQUE NOT NULL,
  DeptCode NVARCHAR(10) UNIQUE NOT NULL,
  HeadCount INT DEFAULT 0,
  CreatedAt DATETIME DEFAULT GETDATE()
);

-- Roles Table
CREATE TABLE Roles (
  RoleID INT IDENTITY(1,1) PRIMARY KEY,
  RoleName NVARCHAR(50) UNIQUE NOT NULL,
  BaseSalary INT NOT NULL,
  DeptID INT,
  FOREIGN KEY (DeptID) REFERENCES Departments(DeptID)
);

-- Employees Table
CREATE TABLE Employees (
  EmpID NVARCHAR(10) PRIMARY KEY,
  Name NVARCHAR(100) NOT NULL,
  DeptID INT NOT NULL,
  RoleID INT NOT NULL,
  BasicSalary INT NOT NULL,
  JoiningDate DATE NOT NULL,
  Email NVARCHAR(100),
  Phone NVARCHAR(15),
  Status NVARCHAR(10) DEFAULT 'Active',
  FOREIGN KEY (DeptID) REFERENCES Departments(DeptID),
  FOREIGN KEY (RoleID) REFERENCES Roles(RoleID)
);

-- MonthlyRecords Table
CREATE TABLE MonthlyRecords (
  RecordID INT IDENTITY(1,1) PRIMARY KEY,
  EmpID NVARCHAR(10) NOT NULL,
  Month NVARCHAR(10) NOT NULL,
  Year INT NOT NULL,
  WorkingDays INT DEFAULT 26,
  PresentDays INT DEFAULT 26,
  BasicSalary INT,
  Bonus INT DEFAULT 0,
  Deduction INT DEFAULT 0,
  NetSalary INT,
  FOREIGN KEY (EmpID) REFERENCES Employees(EmpID),
  CONSTRAINT UQ_EmpMonthYear UNIQUE (EmpID,Month,Year)
);

-- Insert Users
INSERT INTO Users (Username, Password, Role) VALUES ('admin', 'admin123', 'admin');
INSERT INTO Users (Username, Password, Role) VALUES ('user', 'user123', 'user');

-- Insert Departments
INSERT INTO Departments (DeptName, DeptCode) VALUES ('IT', 'IT');
INSERT INTO Departments (DeptName, DeptCode) VALUES ('HR', 'HR');
INSERT INTO Departments (DeptName, DeptCode) VALUES ('Finance', 'FIN');
INSERT INTO Departments (DeptName, DeptCode) VALUES ('Sales', 'SLS');
INSERT INTO Departments (DeptName, DeptCode) VALUES ('Design', 'DSG');
INSERT INTO Departments (DeptName, DeptCode) VALUES ('Operations', 'OPS');
INSERT INTO Departments (DeptName, DeptCode) VALUES ('Management', 'MGT');

-- Insert Roles
INSERT INTO Roles (RoleName, BaseSalary, DeptID) SELECT 'CEO', 180000, DeptID FROM Departments WHERE DeptName='Management';
INSERT INTO Roles (RoleName, BaseSalary, DeptID) SELECT 'CTO', 175000, DeptID FROM Departments WHERE DeptName='Management';
INSERT INTO Roles (RoleName, BaseSalary, DeptID) SELECT 'CFO', 170000, DeptID FROM Departments WHERE DeptName='Finance';
INSERT INTO Roles (RoleName, BaseSalary, DeptID) SELECT 'VP Engineering', 140000, DeptID FROM Departments WHERE DeptName='IT';
INSERT INTO Roles (RoleName, BaseSalary, DeptID) SELECT 'VP Sales', 130000, DeptID FROM Departments WHERE DeptName='Sales';
INSERT INTO Roles (RoleName, BaseSalary, DeptID) SELECT 'VP HR', 120000, DeptID FROM Departments WHERE DeptName='HR';
INSERT INTO Roles (RoleName, BaseSalary, DeptID) VALUES ('Senior Manager', 95000, NULL);
INSERT INTO Roles (RoleName, BaseSalary, DeptID) VALUES ('Manager', 80000, NULL);
INSERT INTO Roles (RoleName, BaseSalary, DeptID) VALUES ('Team Lead', 70000, NULL);
INSERT INTO Roles (RoleName, BaseSalary, DeptID) SELECT 'Senior Developer', 65000, DeptID FROM Departments WHERE DeptName='IT';
INSERT INTO Roles (RoleName, BaseSalary, DeptID) SELECT 'Developer', 50000, DeptID FROM Departments WHERE DeptName='IT';
INSERT INTO Roles (RoleName, BaseSalary, DeptID) SELECT 'Junior Developer', 35000, DeptID FROM Departments WHERE DeptName='IT';
INSERT INTO Roles (RoleName, BaseSalary, DeptID) VALUES ('Senior Analyst', 60000, NULL);
INSERT INTO Roles (RoleName, BaseSalary, DeptID) VALUES ('Analyst', 45000, NULL);
INSERT INTO Roles (RoleName, BaseSalary, DeptID) VALUES ('Junior Analyst', 30000, NULL);
INSERT INTO Roles (RoleName, BaseSalary, DeptID) SELECT 'Senior Designer', 58000, DeptID FROM Departments WHERE DeptName='Design';
INSERT INTO Roles (RoleName, BaseSalary, DeptID) SELECT 'Designer', 44000, DeptID FROM Departments WHERE DeptName='Design';
INSERT INTO Roles (RoleName, BaseSalary, DeptID) SELECT 'DevOps Engineer', 62000, DeptID FROM Departments WHERE DeptName='IT';
INSERT INTO Roles (RoleName, BaseSalary, DeptID) SELECT 'QA Engineer', 48000, DeptID FROM Departments WHERE DeptName='IT';
INSERT INTO Roles (RoleName, BaseSalary, DeptID) SELECT 'HR Manager', 55000, DeptID FROM Departments WHERE DeptName='HR';
INSERT INTO Roles (RoleName, BaseSalary, DeptID) SELECT 'HR Executive', 38000, DeptID FROM Departments WHERE DeptName='HR';
INSERT INTO Roles (RoleName, BaseSalary, DeptID) SELECT 'Sales Manager', 60000, DeptID FROM Departments WHERE DeptName='Sales';
INSERT INTO Roles (RoleName, BaseSalary, DeptID) SELECT 'Sales Executive', 40000, DeptID FROM Departments WHERE DeptName='Sales';
INSERT INTO Roles (RoleName, BaseSalary, DeptID) SELECT 'Accountant', 45000, DeptID FROM Departments WHERE DeptName='Finance';
INSERT INTO Roles (RoleName, BaseSalary, DeptID) SELECT 'Finance Analyst', 52000, DeptID FROM Departments WHERE DeptName='Finance';
INSERT INTO Roles (RoleName, BaseSalary, DeptID) SELECT 'Admin Executive', 35000, DeptID FROM Departments WHERE DeptName='Operations';
INSERT INTO Roles (RoleName, BaseSalary, DeptID) VALUES ('Intern', 18000, NULL);

-- Insert Employees (55)
INSERT INTO Employees VALUES ('EMP001', 'Rahul Sharma', 1, 10, 65000, '2021-03-15', 'rahul.s@ems.com', '9876543201', 'Active');
INSERT INTO Employees VALUES ('EMP002', 'Priya Jain', 1, 11, 50000, '2022-06-01', 'priya.j@ems.com', '9876543202', 'Active');
INSERT INTO Employees VALUES ('EMP003', 'Amit Kumar', 1, 12, 35000, '2023-01-10', 'amit.k@ems.com', '9876543203', 'Active');
INSERT INTO Employees VALUES ('EMP004', 'Sneha Verma', 1, 18, 62000, '2021-09-20', 'sneha.v@ems.com', '9876543204', 'Active');
INSERT INTO Employees VALUES ('EMP005', 'Karan Mehta', 1, 19, 48000, '2022-04-05', 'karan.m@ems.com', '9876543205', 'Active');
INSERT INTO Employees VALUES ('EMP006', 'Neha Patel', 1, 9, 70000, '2020-07-12', 'neha.p@ems.com', '9876543206', 'Active');
INSERT INTO Employees VALUES ('EMP007', 'Rohit Singh', 1, 10, 65000, '2021-11-30', 'rohit.s@ems.com', '9876543207', 'Active');
INSERT INTO Employees VALUES ('EMP008', 'Anjali Gupta', 1, 11, 50000, '2023-03-22', 'anjali.g@ems.com', '9876543208', 'Active');
INSERT INTO Employees VALUES ('EMP009', 'Vikas Yadav', 1, 12, 35000, '2024-01-08', 'vikas.y@ems.com', '9876543209', 'Active');
INSERT INTO Employees VALUES ('EMP010', 'Pooja Mishra', 1, 19, 48000, '2022-08-14', 'pooja.m@ems.com', '9876543210', 'Active');
INSERT INTO Employees VALUES ('EMP011', 'Sunita Rao', 2, 20, 55000, '2019-05-10', 'sunita.r@ems.com', '9876543211', 'Active');
INSERT INTO Employees VALUES ('EMP012', 'Deepak Joshi', 2, 21, 38000, '2021-02-28', 'deepak.j@ems.com', '9876543212', 'Active');
INSERT INTO Employees VALUES ('EMP013', 'Kavita Nair', 2, 21, 38000, '2022-10-05', 'kavita.n@ems.com', '9876543213', 'Active');
INSERT INTO Employees VALUES ('EMP014', 'Manoj Tiwari', 2, 20, 55000, '2020-06-18', 'manoj.t@ems.com', '9876543214', 'Active');
INSERT INTO Employees VALUES ('EMP015', 'Rekha Agarwal', 2, 21, 38000, '2023-05-01', 'rekha.a@ems.com', '9876543215', 'Active');
INSERT INTO Employees VALUES ('EMP016', 'Arun Kapoor', 3, 3, 170000, '2017-01-15', 'arun.k@ems.com', '9876543216', 'Active');
INSERT INTO Employees VALUES ('EMP017', 'Shalini Chandra', 3, 25, 52000, '2021-07-20', 'shalini.c@ems.com', '9876543217', 'Active');
INSERT INTO Employees VALUES ('EMP018', 'Rakesh Dubey', 3, 24, 45000, '2020-03-12', 'rakesh.d@ems.com', '9876543218', 'Active');
INSERT INTO Employees VALUES ('EMP019', 'Nisha Pandey', 3, 25, 52000, '2022-09-08', 'nisha.p@ems.com', '9876543219', 'Active');
INSERT INTO Employees VALUES ('EMP020', 'Suresh Malhotra', 3, 24, 45000, '2021-12-01', 'suresh.m@ems.com', '9876543220', 'Active');
INSERT INTO Employees VALUES ('EMP021', 'Geeta Sharma', 3, 25, 52000, '2023-04-15', 'geeta.s@ems.com', '9876543221', 'Active');
INSERT INTO Employees VALUES ('EMP022', 'Vikram Bose', 4, 5, 130000, '2018-08-10', 'vikram.b@ems.com', '9876543222', 'Active');
INSERT INTO Employees VALUES ('EMP023', 'Meena Kulkarni', 4, 22, 60000, '2020-11-25', 'meena.k@ems.com', '9876543223', 'Active');
INSERT INTO Employees VALUES ('EMP024', 'Arjun Reddy', 4, 23, 40000, '2022-01-10', 'arjun.r@ems.com', '9876543224', 'Active');
INSERT INTO Employees VALUES ('EMP025', 'Divya Iyer', 4, 23, 40000, '2022-06-20', 'divya.i@ems.com', '9876543225', 'Active');
INSERT INTO Employees VALUES ('EMP026', 'Harsh Agarwal', 4, 22, 60000, '2021-04-05', 'harsh.a@ems.com', '9876543226', 'Active');
INSERT INTO Employees VALUES ('EMP027', 'Pallavi Singh', 4, 23, 40000, '2023-02-14', 'pallavi.s@ems.com', '9876543227', 'Active');
INSERT INTO Employees VALUES ('EMP028', 'Rajan Verma', 4, 23, 40000, '2023-07-01', 'rajan.v@ems.com', '9876543228', 'Active');
INSERT INTO Employees VALUES ('EMP029', 'Ananya Roy', 5, 16, 58000, '2020-09-15', 'ananya.r@ems.com', '9876543229', 'Active');
INSERT INTO Employees VALUES ('EMP030', 'Siddharth Menon', 5, 17, 44000, '2022-03-08', 'sid.m@ems.com', '9876543230', 'Active');
INSERT INTO Employees VALUES ('EMP031', 'Tanya Bhatt', 5, 17, 44000, '2023-01-20', 'tanya.b@ems.com', '9876543231', 'Active');
INSERT INTO Employees VALUES ('EMP032', 'Kunal Shah', 5, 16, 58000, '2021-06-10', 'kunal.s@ems.com', '9876543232', 'Active');
INSERT INTO Employees VALUES ('EMP033', 'Ramesh Patil', 6, 8, 80000, '2019-11-05', 'ramesh.p@ems.com', '9876543233', 'Active');
INSERT INTO Employees VALUES ('EMP034', 'Usha Devi', 6, 26, 35000, '2021-08-22', 'usha.d@ems.com', '9876543234', 'Active');
INSERT INTO Employees VALUES ('EMP035', 'Bharat Naik', 6, 26, 35000, '2022-05-30', 'bharat.n@ems.com', '9876543235', 'Active');
INSERT INTO Employees VALUES ('EMP036', 'Smita Joshi', 6, 8, 80000, '2020-02-14', 'smita.j@ems.com', '9876543236', 'Active');
INSERT INTO Employees VALUES ('EMP037', 'Dr. Rajiv Khanna', 7, 1, 180000, '2015-04-01', 'rajiv.k@ems.com', '9876543237', 'Active');
INSERT INTO Employees VALUES ('EMP038', 'Prerna Saxena', 7, 2, 175000, '2016-06-15', 'prerna.s@ems.com', '9876543238', 'Active');
INSERT INTO Employees VALUES ('EMP039', 'Nikhil Chopra', 7, 4, 140000, '2017-09-20', 'nikhil.c@ems.com', '9876543239', 'Active');
INSERT INTO Employees VALUES ('EMP040', 'Swati Rastogi', 7, 6, 120000, '2018-03-10', 'swati.r@ems.com', '9876543240', 'Active');
INSERT INTO Employees VALUES ('EMP041', 'Lalit Awasthi', 1, 11, 50000, '2023-06-12', 'lalit.a@ems.com', '9876543241', 'Active');
INSERT INTO Employees VALUES ('EMP042', 'Priti Sinha', 1, 10, 65000, '2021-01-25', 'priti.s@ems.com', '9876543242', 'Active');
INSERT INTO Employees VALUES ('EMP043', 'Mohit Garg', 1, 18, 62000, '2022-11-08', 'mohit.g@ems.com', '9876543243', 'Active');
INSERT INTO Employees VALUES ('EMP044', 'Seema Bansal', 1, 19, 48000, '2023-09-01', 'seema.b@ems.com', '9876543244', 'Active');
INSERT INTO Employees VALUES ('EMP045', 'Ashish Trivedi', 4, 23, 40000, '2024-02-01', 'ashish.t@ems.com', '9876543245', 'Active');
INSERT INTO Employees VALUES ('EMP046', 'Ritu Ghosh', 4, 22, 60000, '2020-07-15', 'ritu.g@ems.com', '9876543246', 'Active');
INSERT INTO Employees VALUES ('EMP047', 'Vinod Misra', 3, 24, 45000, '2022-02-20', 'vinod.m@ems.com', '9876543247', 'Active');
INSERT INTO Employees VALUES ('EMP048', 'Aarti Pillai', 3, 25, 52000, '2023-10-10', 'aarti.p@ems.com', '9876543248', 'Active');
INSERT INTO Employees VALUES ('EMP049', 'Sachin Wagh', 2, 21, 38000, '2024-01-15', 'sachin.w@ems.com', '9876543249', 'Active');
INSERT INTO Employees VALUES ('EMP050', 'Ishaan Batra', 5, 17, 44000, '2023-08-20', 'ishaan.b@ems.com', '9876543250', 'Active');
INSERT INTO Employees VALUES ('EMP051', 'Nandini Jain', 6, 26, 35000, '2023-11-05', 'nandini.j@ems.com', '9876543251', 'Active');
INSERT INTO Employees VALUES ('EMP052', 'Prasad Kulkarni', 6, 8, 80000, '2019-05-28', 'prasad.k@ems.com', '9876543252', 'Active');
INSERT INTO Employees VALUES ('EMP053', 'Shruti Agarwal', 1, 27, 18000, '2025-09-01', 'shruti.a@ems.com', '9876543253', 'Active');
INSERT INTO Employees VALUES ('EMP054', 'Mihir Shah', 5, 27, 18000, '2025-09-01', 'mihir.s@ems.com', '9876543254', 'Active');
INSERT INTO Employees VALUES ('EMP055', 'Tanvi Mehta', 2, 27, 18000, '2025-09-01', 'tanvi.m@ems.com', '9876543255', 'Active');

-- Insert Monthly Records (55 employees × 4 months = 220 records)
INSERT INTO MonthlyRecords (EmpID, Month, Year, WorkingDays, PresentDays, BasicSalary, Bonus, Deduction, NetSalary)
SELECT EmpID, 'October', 2025, 26, 25, BasicSalary, 5000, CAST(BasicSalary * 0.1 AS INT), CAST(BasicSalary * 0.9 AS INT) FROM Employees;

INSERT INTO MonthlyRecords (EmpID, Month, Year, WorkingDays, PresentDays, BasicSalary, Bonus, Deduction, NetSalary)
SELECT EmpID, 'November', 2025, 26, 26, BasicSalary, 7000, CAST(BasicSalary * 0.1 AS INT), CAST(BasicSalary * 0.9 AS INT) FROM Employees;

INSERT INTO MonthlyRecords (EmpID, Month, Year, WorkingDays, PresentDays, BasicSalary, Bonus, Deduction, NetSalary)
SELECT EmpID, 'December', 2025, 26, 25, BasicSalary, 10000, CAST(BasicSalary * 0.1 AS INT), CAST(BasicSalary * 0.9 AS INT) FROM Employees;

INSERT INTO MonthlyRecords (EmpID, Month, Year, WorkingDays, PresentDays, BasicSalary, Bonus, Deduction, NetSalary)
SELECT EmpID, 'January', 2026, 26, 26, BasicSalary, 8000, CAST(BasicSalary * 0.1 AS INT), CAST(BasicSalary * 0.9 AS INT) FROM Employees;

-- Update Department HeadCount
UPDATE Departments SET HeadCount = (SELECT COUNT(*) FROM Employees WHERE DeptID = Departments.DeptID AND Status = 'Active');

SELECT 'Database Setup Complete!' AS Status;