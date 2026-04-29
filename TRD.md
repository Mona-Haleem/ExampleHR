# ExampleHR Time-Off Microservice 

## Problem Statement:
ExampleHR serves as the employee-facing interface for time-off requests, while the HCM (e.g., Workday) remains the Source of Truth for employment data. The core challenge is maintaining the Time Off balance consistency across two systems that can both independently mutate the same data, while ensuring employees receive accurate, real-time feedback on their requests.


## Key Challenges:
1. **Dual-write consistency** — When an employee submits a request on ExampleHR, we must deduct from both our local cache **(DB)** and the HCM. If the HCM write succeeds but our local write fails (or vice versa), the systems diverge.
2. **External balance mutations** — The HCM may update balances independently (work anniversary accruals, year-start resets). ExampleHR has no guarantee of being notified in real time.
3. **Race conditions** — Two simultaneous requests from the same employee could both pass a local balance check before either deduction is committed, resulting in an overdraft.
4. **Unreliable HCM error responses** — The HCM may not always return an error on insufficient balance. We cannot treat HCM approval as a guarantee of validity.

## Technology Stack:
- **Framework**: NestJS (TypeScript)
- **Database**: SQLite (via TypeORM)
- **Testing**: Jest (unit + integration + e2e)
- **Scheduling**: @nestjs/schedule (cron jobs)
- **HTTP Client**: @nestjs/axios (HCM API calls)

## Design Assumptions:
- Balances are scoped **per-employee per-location**. An employee at location A may have a different balance than at location B.
- The HCM is the Source of Truth for balances. ExampleHR maintains a local cache for fast reads and optimistic feedback.
- ExampleHR does not handle authentication/identity directly; employee and manager identities are passed via request headers or JWT from an upstream auth service.

## Proposed Solution:

### High Level Design:
Use an **eventual consistency** strategy to maintain the Time Off balance.

- Maintain a local copy of employee balances table as a performance cache.

- Use a request tracking table to track the status of each request.

- provide optimistic feedback to the employee. Available balance is computed as:
  `availableBalance = balance - (pending request days) - (approved but not yet synced request days)`
  The `balance` column only updates when HCM confirms via sync.

- use cron jobs as fallback mechanisms to reconcile data between ExampleHR and HCM.

- immediate sync with HCM once manager approves a request (primary sync path). Cron jobs handle retries for failed syncs.

### Request Lifecycle:

**Status State Machine:** PENDING → APPROVED → SYNCED | SYNC_FAILED, PENDING → REJECTED, PENDING → CANCELLED, PENDING → EXPIRED

1. Employee selects time-off dates and submits a time-off request.
2. ExampleHR performs a **defensive local validation**: checks that `availableBalance >= requested days` (where availableBalance = balance - pending days - approved days).
3. If within balance: a new request is registered in the DB with status **PENDING** and a log entry is created.
4. If out of balance: no request is registered; the employee receives an insufficient balance error.
5. The manager reviews and approves or rejects the request:
   - A log entry is created reflecting the manager's action.
6. **On approval:** status changes to **APPROVED**, then ExampleHR immediately calls HCM to submit the time-off dates. 
   - If HCM confirms: status updates to **SYNCED**, local `balance` column is updated with the new value returned by HCM.
   - If HCM returns a balance/validation error: status updates to **SYNC_FAILED**, employee is notified.
   - If HCM returns a server/connection error: status stays **APPROVED**, retry is handled by the hourly cron job.
7. **On rejection:** status changes to **REJECTED**. Reserved days are released from available balance calculation.
8. **On cancellation (by employee, only while PENDING):** status changes to **CANCELLED**. Reserved days are released.

9. **Hourly cron job** (retry fallback):
    a. Retries syncing any requests stuck in **APPROVED** status (failed immediate sync).
    b. Marks requests whose dates are all in the past as **EXPIRED**.

10. **Daily cron job** (reconciliation):
    a. Calls HCM batch endpoint to fetch all employee balances.
    b. Updates local `balance` column to match HCM values, correcting any drift.


### Sync Strategy:
- **Real-time** (on manager approval): ExampleHR calls HCM real-time API to submit the approved time-off request. Retries up to 3 times on transient failure with 10s interval between retries. On success, updates local balance and request status to SYNCED.

- **Hourly retry**: Cron job picks up requests stuck in APPROVED status (i.e., real-time sync failed after all retries) and reattempts HCM sync.

- **Daily reconciliation**: Cron job calls HCM batch endpoint, fetches all employee balances, and overwrites local `balance` column to correct any drift from external mutations (anniversary accruals, year-start resets).

- **On-demand re-sync**: If HCM returns a balance validation error during real-time sync, ExampleHR immediately fetches the current balance for that employee+location and updates the local cache before marking the request as SYNC_FAILED.


### Error Handling Strategy:
- Failed sync due to server or connection errors: the hourly cron job will retry until it succeeds.

- Failed sync due to balance/validation errors: the request status will be updated to SYNC_FAILED and the employee will be notified.

- Overlapping date requests are prevented by checking that no existing PENDING or APPROVED request contains any of the same dates for the same employee+location before inserting.

- To avoid incomplete DB updates, use transactions to wrap multiple writes.

### Defensive Validation Strategy:
The HCM may not always return errors for invalid requests (e.g., approving a request when balance is actually 0). To guard against this:

1. **Pre-submission check**: Before sending to HCM, ExampleHR always validates locally that `availableBalance >= requested days`. This catches obvious overdrafts even if HCM would silently accept them.
2. **Post-sync verification**: After HCM returns a success response with the new balance, ExampleHR verifies the returned balance is non-negative. If it is negative, the request is flagged as SYNC_FAILED and an alert is logged.
3. **Daily reconciliation as safety net**: The daily batch sync detects any balance drift caused by HCM silently accepting invalid requests, and corrects the local cache.

### Concurrency Control (Race Conditions):
To prevent two simultaneous requests from overdrawing the same balance:
- The `balance_table` includes a `version` column (integer, starts at 1).
- On every balance read, the current version is captured.
- On write (balance deduction or update), the UPDATE query includes `WHERE version = :captured_version` and increments version.
- If the row was modified by another transaction in between, the WHERE clause matches 0 rows → the operation fails and is retried or rejected.
- SQLite's serialized write lock provides additional safety for single-writer scenarios.

### Database Schema:
- balance_table:{
    employee_id,
    location_id,
    balance,
    version (integer, for optimistic locking),
    last_synced_at,
    primary_key(employee_id, location_id)
}
- time_off_request_table:{
    request_id (UUID),
    employee_id,
    location_id,
    days_count (integer),
    status (PENDING | APPROVED | SYNCED | SYNC_FAILED | REJECTED | CANCELLED | EXPIRED),
    created_date,
    updated_date,
    primary_key(request_id)
}

- time_off_requested_dates:{
    request_id,
    date,
    primary_key(request_id, date)
}

- time_off_request_logs:{
    id (auto-increment),
    request_id,
    previous_status,
    new_status,
    update_date,
    primary_key(id)
}

**Indexes:**
- `idx_request_employee_status` on time_off_request_table(employee_id, location_id, status) — for available balance calculation
- `idx_request_status` on time_off_request_table(status) — for cron job queries (find APPROVED requests)

### NestJS Module Structure:
```
src/
  app.module.ts
  time-off/
    time-off.module.ts
    time-off.controller.ts       # REST endpoints
    time-off.service.ts          # Business logic
    entities/
      balance.entity.ts
      time-off-request.entity.ts
      requested-date.entity.ts
      request-log.entity.ts
  hcm/
    hcm.module.ts
    hcm.service.ts               # HTTP client wrapper for HCM API
  sync/
    sync.module.ts
    sync.service.ts              # Cron jobs + sync logic
```

### API Contract:
- POST /time-off/requests: Submit a new request
**req**:{
   employee_id,
   location_id,
   datesList:["yyyy-mm-dd","yyyy-mm-dd"...],
}
**res**:
success:
status 201
data{
    request_id,
    status,
    remainingBalance, reservedBalance
}
failure:
status 400 — invalid dates (past dates, empty list)
status 409 — overlapping dates with existing PENDING/APPROVED request
status 422
error:{
    "message": "insufficient balance"
}    
- GET /time-off/requests?status={value}&employeeId={value}: Get requests. Managers see all; employees see only their own (enforced server-side). Optional filters: status, employeeId.
**res**:
success:
status 200
data{
    {
    request_id,
    employee_id,
    location_id,
    days_count,
    status,
    datesList,
    created_date,
    updated_date
    }[]
}
failure:
status 403
error:{
    "message": "not authorized"
}    

- GET /time-off/requests/{requestId}: Get a specific request. Accessible by the owning employee and managers.
**res**:
success:
status 200
data{
    request_id,
    employee_id,
    location_id,
    days_count,
    status,
    datesList,
    created_date,
    updated_date
}
failure:
status 404
error:{
    "message": "not found"
} 
status 403
error:{
    "message": "not authorized"
}    

- PATCH /time-off/requests/{requestId}/approve: Manager approves only if status is PENDING
**res**:
success:
status 200
data{
    request_id,
    status: "APPROVED",
    hcmSyncStatus: "SYNCED" | "PENDING_RETRY" | "SYNC_FAILED",
}
failure:
status 409
error:{
    "message": "request is not in PENDING status"
}
status 500
error:{
    "message": "failed to update request"
}   


- PATCH /time-off/requests/{requestId}/reject: Manager rejects only if status is PENDING
**res**:
success:
status 200
data{
    request_id,
    status: "REJECTED",
    remainingBalance, reservedBalance
}
failure:
status 409
error:{
    "message": "request is not in PENDING status"
}
status 500
error:{
    "message": "failed to update request"
}    

- PATCH /time-off/requests/{requestId}/cancel: Employee cancels only if status is PENDING
**res**:
success:
status 200
data{
    request_id,
    status: "CANCELLED",
    remainingBalance, reservedBalance
}
failure:
status 403
error:{
    "message": "not authorized"
}    
status 409
error:{
    "message": "request is not in PENDING status, cannot cancel"
}    

- GET /time-off/balances/{locationId}/{employeeId}: Get current balance for an employee at a location
**res**:
success:
status 200
data{
    employee_id,
    location_id,
    balance (raw HCM-synced value),
    availableBalance (balance - pending days - approved days),
    reservedBalance (pending days + approved days),
    last_synced_at
}
failure:
status 404
error:{
    "message": "balance record not found for this employee+location"
}

## Alternatives Considered
1. **HCM as the only source, no local DB** — Rejected because it makes every balance read dependent on HCM availability, creating latency and a single point of failure.
2. **Event queue (e.g., SQS) for all HCM writes** — More robust but over-engineered for this scope; adds operational complexity without proportional benefit at this stage.
3. **Update local DB balance before HCM confirms** — Rejected because it requires rollback on HCM failure/rejection, making the system error-prone. Using request status for optimistic feedback suffices.
4. **Only scheduled batch jobs for HCM sync** — Rejected because delayed sync increases stale data risk. Immediate sync on manager approval with daily batch reconciliation provides better consistency.


## Test Cases:
### unit tests:
Test the service logic in complete isolation. The HCM client and database are mocked.

- getBalance() with valid employee and location IDs → returns balance

- getBalance() with invalid employee and location IDs → throws NotFoundException

- submitRequest() with sufficient balance → returns pending status

- submitRequest() with zero balance → throws InsufficientBalanceException

- submitRequest() with incorrect combination of employee and location IDs → throws NotFoundException

- getRequest() with valid request id → returns request status

- getRequest() with invalid request id → throws NotFoundException

- getAllRequests() returns all requests

- getRequestByStatus() returns requests based on the status 

- approveRequest() on pending request → updates status to APPROVED, triggers HCM sync  

- approveRequest() on non-PENDING request → throws ConflictException

- rejectRequest() on pending request → updates status to REJECTED, releases reserved days 

- cancelRequest() on pending request → updates status to CANCELLED, releases reserved days 

- cancelRequest() on APPROVED/SYNCED request → throws ConflictException 

- syncRequests() → update request status to SYNCED if HCM returns success 
 
- syncRequests() → update request status to SYNC_FAILED if HCM returns validation error (non-500)

- syncRequests() → retry 3 times on transient failure (500/network) with 10s interval

- syncRequests() → after successful sync, verify returned balance is non-negative (defensive check)

- expireRequests() → update request status to EXPIRED if all request dates are in the past

- submitRequest() with dates overlapping existing PENDING/APPROVED request → throws ConflictException



### integration tests:
Test service + real SQLite database together, HCM is mocked via HTTP interceptor.

- Submit request → verify request row + log row + requested_dates rows created in DB within a transaction

- Submit request → verify availableBalance is correctly reduced (balance - pending - approved days)

- Approve request → verify HCM client called, request status transitions to SYNCED, balance updated in DB

- Approve request when HCM returns 500 → status stays APPROVED (retry candidate), balance unchanged

- Reject request → verify reserved days released, availableBalance increases

- Cancel request → verify reserved days released, status is CANCELLED

- Two simultaneous requests for same employee both pass balance check → optimistic lock (version column) prevents double deduction

- Daily batch sync → verify local balance updated to match HCM batch response, correcting drift

- Hourly cron → verify APPROVED (stuck) requests are retried and transition to SYNCED

- Hourly cron → verify past-dated PENDING requests transition to EXPIRED


### e2e scenario tests:
Full request lifecycle tests using real HTTP calls against running NestJS app + mock HCM server.

- Employee with sufficient balance submits request and manager approves → balance decremented, status SYNCED

- Employee with insufficient balance submits request → 422 returned, no request created

- HCM returns success but balance is actually 0 (unreliable HCM) → post-sync defensive check catches negative balance, flags as SYNC_FAILED

- HCM is down (mock returns 500) → request stays APPROVED, hourly cron retries later

- Two simultaneous requests that together exceed balance → only one succeeds

- Daily batch sync corrects a drifted local balance → verified after cron job runs

- Employee submits request with dates overlapping an existing PENDING request → 409 returned





## Assumed HCM (Mock Server) Design:

### API endpoint:
1. POST /time-off/requests: 
- Approve or reject a time-off request
- success:
    1. Approval: update DB and return 201 with new balance and accepted dates list (excluding holiday dates)
    2. Unreliable approval: when balance is 0 but HCM returns 200 OK anyway (simulates unreliable error)   
- failure:
    1. Server internal error → return 500 
    2. Insufficient balance → return 422
    3. Invalid employee+location combination → return 404 
    4. Date overlap with previously approved dates → return 409

2. GET /time-off/balances/:locationId/:employeeId:

- Get current balance for a specific employee at a specific location.
- success: returns the employee's current balance (allocated_balance - aggregated leave dates count in current year via SQL join)

- failure: 
1. Invalid employee+location combination → return 404 Not Found
2. Server internal error → return 500 


3. GET /batch/balances
- Batch endpoint: returns all employee balances with dimensions (employee_id, location_id).
- ExampleHR **pulls** from this endpoint during the daily reconciliation cron job.
- success: returns the list of all employees with current balance (allocated_balance - aggregated dates count of leaveRecords in current year via SQL join)

- failure: server internal error → return 500 


### Data Model:
- employee: id, name 
- locations: id, name
- balance: id, employee_id, location_id, allocated_balance, last_updated 
- leaveRecord: id, employee_id, location_id, date (single date per row), submitted_date 
- publicHolidays: id, location_id, date, name, type (annual, weekly)

### Mocked Behaviors:
These behaviors simulate real-world HCM unreliability for testing. Controlled via a request counter (not random):
- **Balance drift**: Every 5th request, the mock silently adds 1 day to an employee's balance (simulates anniversary accrual)
- **Transient failure**: Every 10th request, the mock returns HTTP 500 (simulates HCM downtime)
- **Unreliable validation**: Every 10th POST request, the mock accepts a request even when balance is 0 and returns 200 OK (simulates HCM not enforcing balance checks)