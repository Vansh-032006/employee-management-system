USE EMS_DB;
GO

-- ════════════════════════════════════════════════════════════════
-- SELECT QUERIES (1-15) — From server.js getData()
-- ════════════════════════════════════════════════════════════════

-- 1. Dashboard: Count Total Active Employees
SELECT COUNT(*) AS TotalEmployees 
FROM Employees WHERE Status='Active';

-- 2. Dashboard: Total Monthly Payroll (January 2026)
SELECT SUM(NetSalary) AS TotalPayroll 
FROM MonthlyRecords WHERE Month='January' AND Year=2026;

-- 3. Dashboard: Count Total Departments
SELECT COUNT(*) AS TotalDepts 
FROM Departments;

-- 4. Dashboard: Total Bonus Paid (January 2026)
SELECT SUM(Bonus) AS TotalBonus 
FROM MonthlyRecords WHERE Month='January' AND Year=2026;

-- 5. Dashboard: Department Breakdown
SELECT d.DeptID, d.DeptName, COUNT(e.EmpID) AS EmpCount
FROM Departments d 
LEFT JOIN Employees e ON d.DeptID=e.DeptID
GROUP BY d.DeptID, d.DeptName

-- 6. Dashboard: Recently Joined Employees (Top 5)
SELECT TOP 5 e.EmpID, e.Name, d.DeptName, e.JoiningDate 
FROM Employees e JOIN Departments d ON e.DeptID=d.DeptID ORDER BY e.JoiningDate DESC;

-- 7. Dashboard: Monthly Payroll Trend
SELECT Month, Year, SUM(NetSalary) AS TotalNet 
FROM MonthlyRecords GROUP BY Month, Year ORDER BY Year;

-- 8. Employees: Get All Active Employees
SELECT e.EmpID, e.Name, d.DeptName AS Department, r.RoleName, e.BasicSalary 
FROM Employees e JOIN Departments d ON e.DeptID=d.DeptID JOIN Roles r ON e.RoleID=r.RoleID 
WHERE e.Status='Active';

-- 9. Employees: Filter by Department (IT)
SELECT e.EmpID, e.Name, d.DeptName, r.RoleName, e.BasicSalary 
FROM Employees e JOIN Departments d ON e.DeptID=d.DeptID JOIN Roles r ON e.RoleID=r.RoleID 
WHERE d.DeptName='IT' AND e.Status='Active';

-- 10. Employees: Search by Name
SELECT e.EmpID, e.Name, d.DeptName, r.RoleName, e.BasicSalary 
FROM Employees e JOIN Departments d ON e.DeptID=d.DeptID JOIN Roles r ON e.RoleID=r.RoleID 
WHERE e.Name LIKE '%Rahul%' AND e.Status='Active';

-- 11. Salary: Get All Monthly Records
SELECT mr.RecordID, mr.EmpID, e.Name, mr.Month, mr.Year, mr.BasicSalary, mr.Bonus, mr.Deduction, mr.NetSalary 
FROM MonthlyRecords mr JOIN Employees e ON mr.EmpID=e.EmpID 
WHERE e.Status='Active';

-- 12. Salary: Filter by Month & Year (January 2026)
SELECT mr.EmpID, e.Name, d.DeptName, mr.BasicSalary, mr.Bonus, mr.Deduction, mr.NetSalary 
FROM MonthlyRecords mr JOIN Employees e ON mr.EmpID=e.EmpID JOIN Departments d ON e.DeptID=d.DeptID
WHERE mr.Month='January' AND mr.Year=2026;

-- 13. Departments: Get All with Stats
SELECT d.DeptID, d.DeptName, d.DeptCode, COUNT(e.EmpID) AS EmpCount, SUM(e.BasicSalary) AS TotalSalary 
FROM Departments d LEFT JOIN Employees e ON d.DeptID=e.DeptID AND e.Status='Active'
GROUP BY d.DeptID, d.DeptName, d.DeptCode;

-- 14. Roles: Get All Roles with Department Names
SELECT r.RoleID, r.RoleName, r.BaseSalary, d.DeptName 
FROM Roles r LEFT JOIN Departments d ON r.DeptID=d.DeptID 
ORDER BY r.BaseSalary DESC;

-- 15. Roles: Filter by Department (IT)
SELECT r.RoleID, r.RoleName, r.BaseSalary, d.DeptName 
FROM Roles r LEFT JOIN Departments d ON r.DeptID=d.DeptID
WHERE d.DeptName='IT' OR r.DeptID IS NULL;

-- ════════════════════════════════════════════════════════════════
-- INSERT QUERIES (16-25) — From server.js POST routes
-- ════════════════════════════════════════════════════════════════

-- 16. Insert: Add New User
INSERT INTO Users (Username, Password, Role) 
VALUES ('newuser', 'password123', 'user');

-- 17. Insert: Add New Department
INSERT INTO Departments (DeptName, DeptCode)
VALUES ('Marketing', 'MKT');

-- 18. Insert: Add New Role
INSERT INTO Roles (RoleName, BaseSalary, DeptID)
VALUES ('Product Manager', 75000, 1);

-- 19. Insert: Add New Employee
INSERT INTO Employees (EmpID, Name, DeptID, RoleID, BasicSalary, JoiningDate, Email, Phone, Status)
VALUES ('EMP056', 'New Employee', 1, 11, 50000, '2026-01-15', 'new@ems.com', '9876543256', 'Active');

-- 20. Insert: Add Monthly Record for Employee
INSERT INTO MonthlyRecords (EmpID, Month, Year, WorkingDays, PresentDays, BasicSalary, Bonus, Deduction, NetSalary)
VALUES ('EMP056', 'January', 2026, 26, 26, 50000, 0, 5000, 45000);

-- 21. Insert: Batch Add Multiple Employees
INSERT INTO Employees (EmpID, Name, DeptID, RoleID, BasicSalary, JoiningDate, Email, Phone, Status)
VALUES ('EMP057', 'Employee One', 1, 11, 50000, '2026-01-10', 'emp1@ems.com', '9876543257', 'Active');

-- 22. Insert: Copy Monthly Records from Previous Month
INSERT INTO MonthlyRecords (EmpID, Month, Year, WorkingDays, PresentDays, BasicSalary, Bonus, Deduction, NetSalary)
SELECT EmpID, 'February', 2026, WorkingDays, PresentDays, BasicSalary, Bonus, Deduction, NetSalary
FROM MonthlyRecords WHERE Month='January' AND Year=2026;

-- 23. Insert: Add Monthly Records from Employee Salary
INSERT INTO MonthlyRecords (EmpID, Month, Year, WorkingDays, PresentDays, BasicSalary, Bonus, Deduction, NetSalary)
SELECT e.EmpID, 'March', 2026, 26, 25, r.BaseSalary, 5000, CAST(r.BaseSalary*0.1 AS INT), CAST(r.BaseSalary*0.85 AS INT) FROM Employees e JOIN Roles r ON e.RoleID=r.RoleID WHERE e.Status='Active';

-- 24. Insert: Add Role for Specific Department
INSERT INTO Roles (RoleName, BaseSalary, DeptID)
VALUES ('Business Analyst', 58000, 3);

-- 25. Insert: Add General Role (No Department)
INSERT INTO Roles (RoleName, BaseSalary, DeptID)
VALUES ('Consultant', 70000, NULL);

-- ════════════════════════════════════════════════════════════════
-- UPDATE QUERIES (26-35) — From server.js POST edit routes
-- ════════════════════════════════════════════════════════════════

-- 26. Update: Change Employee Name
UPDATE Employees 
SET Name = 'Rahul Kumar Sharma' WHERE EmpID = 'EMP001';

-- 27. Update: Change Employee Salary
UPDATE Employees 
SET BasicSalary = 58000 WHERE EmpID = 'EMP001';

-- 28. Update: Change Employee Department & Role
UPDATE Employees 
SET DeptID = 2, RoleID = 20, BasicSalary = 55000 WHERE EmpID = 'EMP001';

-- 29. Update: Change Employee Contact Info
UPDATE Employees 
SET Email = 'newemail@ems.com', Phone = '9999999999' WHERE EmpID = 'EMP001';

-- 30. Update: Change All Developers Salary (By Role)
UPDATE Employees 
SET BasicSalary = 55000 WHERE RoleID = (SELECT RoleID FROM Roles
WHERE RoleName = 'Developer') AND Status = 'Active';

-- 31. Update: Update Department HeadCount
UPDATE Departments 
SET HeadCount = (SELECT COUNT(*) FROM Employees 
WHERE DeptID = Departments.DeptID AND Status = 'Active');

-- 32. Update: Change Role Name & Base Salary
UPDATE Roles 
SET RoleName = 'Senior Software Engineer', BaseSalary = 70000 
WHERE RoleID = 10;

-- 33. Update: Propagate Role Salary Change to Employees
UPDATE Employees 
SET BasicSalary = 70000
WHERE RoleID = 10 AND Status = 'Active';

-- 34. Update: Add Bonus to Monthly Record
UPDATE MonthlyRecords 
SET Bonus = 10000, NetSalary = BasicSalary + 10000 - Deduction 
WHERE EmpID = 'EMP001' AND Month = 'January' AND Year = 2026;

-- 35. Update: Recalculate All Deductions & Net Salary
UPDATE MonthlyRecords 
SET Deduction = CAST(BasicSalary * 0.1 AS INT), NetSalary = BasicSalary + Bonus - CAST(BasicSalary * 0.1 AS INT)
WHERE Month = 'January' AND Year = 2026;

-- ════════════════════════════════════════════════════════════════
-- DELETE QUERIES (36-40) — Soft Delete (Mark as Inactive)
-- ════════════════════════════════════════════════════════════════

-- 36. Delete: Remove Specific Monthly Record
DELETE FROM MonthlyRecords 
WHERE EmpID = 'EMP056' AND Month = 'January' AND Year = 2026;

-- 37. Delete: Remove All Salary Records for Employee
DELETE FROM MonthlyRecords 
WHERE EmpID = 'EMP057';

-- 38. Delete: Soft Delete (Mark Employee as Inactive)
UPDATE Employees 
SET Status = 'Inactive' WHERE EmpID = 'EMP058';

-- 39. Delete: Mark All Old Employees as Inactive
UPDATE Employees 
SET Status = 'Inactive' WHERE JoiningDate < '2015-01-01';

-- 40. Delete: Hard Delete (Remove Records Permanently)
DELETE FROM Employees 
WHERE JoiningDate < '2015-01-01';


DROP DATABASE IF EXISTS EMS_DB;
GO