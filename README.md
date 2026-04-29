# ExampleHR Time-Off Microservice

## Overview
This microservice manages the lifecycle of employee time-off requests. It provides endpoints for submitting, approving, rejecting, and cancelling requests, while maintaining a local cache of balances and synchronizing state with an external HCM (Human Capital Management) system.

## Architecture
The service follows an **eventual consistency** model:
- **Local Cache**: Employee balances and request statuses are stored locally in SQLite for high performance and availability.
- **HCM Integration**: The external HCM system is the source of truth for final balances. Approved requests are synchronized with the HCM.
- **Sync Strategy**: Requests are synchronized upon approval. A background cron job handles retries for failed syncs and reconciliation.
- See [TRD.md](TRD.md) for detailed technical specifications and status transition logic.

## Tech Stack
- **Framework**: [NestJS](https://nestjs.com/)
- **Database**: SQLite (via TypeORM)
- **Testing**: Jest, Supertest
- **HCM Communication**: Axios (NestJS HttpService)

## Prerequisites
- Node.js 18+
- npm

## Getting Started

1. **Clone the repository**:
   ```bash
   git clone <repository-url>
   cd ExampleHR_Microservices
   ```

2. **Configure environment**:
   ```bash
   cp .env.example .env
   ```

3. **Install dependencies**:
   ```bash
   npm install
   ```

4. **Start mock HCM server**:
   ```bash
   cd mock-hcm-server
   npm install
   npm run start
   ```
   *(Keep this running in a separate terminal)*

5. **Start the main service**:
   ```bash
   # Back in the root directory
   npm run start:dev
   ```

## API Endpoints

| Method | Path | Description |
| :--- | :--- | :--- |
| `POST` | `/time-off/requests` | Submit a new time-off request |
| `GET` | `/time-off/requests` | List all requests (supports `status` and `employeeId` filters) |
| `GET` | `/time-off/requests/:requestId` | Get details of a specific request |
| `PATCH` | `/time-off/requests/:requestId/approve` | Approve a pending request and initiate HCM sync |
| `PATCH` | `/time-off/requests/:requestId/reject` | Reject a pending request |
| `PATCH` | `/time-off/requests/:requestId/cancel` | Cancel a pending request |
| `GET` | `/time-off/balances/:locationId/:employeeId` | Get available and reserved balance for an employee |

## Testing

The project includes a comprehensive test suite covering unit, integration, and e2e scenarios.

- **Unit Tests**: Test individual components with mocked dependencies.
  ```bash
  npm run test
  ```
- **Integration Tests**: Test service logic against a real in-memory SQLite database.
  ```bash
  npm run test test/integration/time-off.integration.spec.ts
  ```
- **E2E Tests**: Test full HTTP flows against a real mock HCM server.
  ```bash
  npm run test:e2e
  ```
- **Coverage Report**: Generate code coverage metrics.
  ```bash
  npm run test:cov
  ```

### Test Configuration in `package.json`
To run specific suites easily, ensure your `package.json` contains scripts like:
```json
"test:integration": "jest test/integration",
"test:e2e": "jest --config ./test/jest-e2e.json"
```

## Mock HCM Server
A standalone Express server that simulates an external HCM system.
- **Port**: 3001
- **Behaviors**: 
  - Simulates network errors and 500 status codes every 10th request.
  - Silently increments balances to simulate external updates.
  - Includes a `/reset` endpoint to restore state between tests.

## Design Decisions
- **Optimistic Concurrency**: The service uses versioning (if implemented in DB) or defensive balance checks before syncing to prevent over-allocation.
- **Fail-Fast local validation**: Requests are validated against local balance before any HCM calls.
- For a deep dive into trade-offs and edge cases, refer to the [TRD.md](TRD.md).
