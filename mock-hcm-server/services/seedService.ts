import Database from 'better-sqlite3';

export default class SeedService {
    static seed(dbInstance: Database.Database) {
        dbInstance.exec(`
            DROP TABLE IF EXISTS employee;
            DROP TABLE IF EXISTS locations;
            DROP TABLE IF EXISTS balance;
            DROP TABLE IF EXISTS leaveRecord;
            DROP TABLE IF EXISTS publicHolidays;

            CREATE TABLE employee (id INTEGER PRIMARY KEY, name TEXT);
            CREATE TABLE locations (id INTEGER PRIMARY KEY, name TEXT);
            CREATE TABLE balance (id INTEGER PRIMARY KEY AUTOINCREMENT, employee_id INTEGER, location_id INTEGER, allocated_balance INTEGER, last_updated DATETIME DEFAULT CURRENT_TIMESTAMP);
            CREATE TABLE leaveRecord (id INTEGER PRIMARY KEY AUTOINCREMENT, employee_id INTEGER, location_id INTEGER, date TEXT, submitted_date DATETIME DEFAULT CURRENT_TIMESTAMP);
            CREATE TABLE publicHolidays (id INTEGER PRIMARY KEY AUTOINCREMENT, location_id INTEGER, date TEXT, name TEXT, type TEXT);

            INSERT INTO employee (id, name) VALUES (1, 'Alice'), (2, 'Bob'), (3, 'Charlie');
            INSERT INTO locations (id, name) VALUES (1, 'New York'), (2, 'London');
            
            INSERT INTO balance (employee_id, location_id, allocated_balance) VALUES 
            (1, 1, 20), (1, 2, 15), 
            (2, 1, 10), (2, 2, 5), 
            (3, 1, 0), (3, 2, 3);

            -- Future dates in 2026 for public holidays
            INSERT INTO publicHolidays (location_id, date, name, type) VALUES 
            (1, '2026-07-04', 'Independence Day', 'annual'),
            (1, '2026-11-26', 'Thanksgiving', 'annual'),
            (2, '2026-05-04', 'Early May Bank Holiday', 'annual'),
            (2, '2026-08-31', 'Summer Bank Holiday', 'annual');
        `);
    }
}
