# Managed Llama Acceptance Rate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Track speculative decoding acceptance rate for managed llama.cpp runs and surface the aggregated rate in the dashboard Metrics tab.

**Architecture:** Parse speculative accepted/generated token totals from managed llama logs, persist those raw counts on completed managed run records, aggregate them through the existing runtime metrics and dashboard daily-metrics pipeline, and render a dedicated Metrics graph derived from totals rather than averaged per-run percentages.

**Tech Stack:** TypeScript, better-sqlite3 runtime DB, Node status server, React dashboard, tsx test runner.

---

### Task 1: Lock failing backend behavior

**Files:**
- Modify: `tests/dashboard-status-server.managed-llama.test.ts`
- Modify: `tests/dashboard-status-server.test.ts`
- Modify: `tests/runtime-metrics-aggregation.test.ts`
- Modify: `dashboard/tests/tab-components.test.tsx`

- [ ] **Step 1: Write failing managed-llama log parsing / persistence assertions**
- [ ] **Step 2: Write failing daily metrics aggregation assertions for accepted/generated totals and derived rate**
- [ ] **Step 3: Write failing Metrics tab rendering assertions for the new acceptance graph**
- [ ] **Step 4: Run the targeted tests and confirm the new assertions fail for the missing fields**

### Task 2: Persist speculative accepted/generated totals

**Files:**
- Modify: `src/status-server/managed-llama.ts`
- Modify: `src/config/status-backend.ts`
- Modify: `src/status-server/status-file.ts`
- Modify: `src/status-server/routes/core.ts`
- Modify: `src/status-server/dashboard-runs.ts`
- Modify: `src/status-server/runtime-cutover.ts`

- [ ] **Step 1: Add a managed-llama log parser that extracts speculative accepted/generated token totals without failing on malformed logs**
- [ ] **Step 2: Post those totals through the managed status backend completion path only**
- [ ] **Step 3: Persist the new totals in `run_logs` and expose them on normalized run records**
- [ ] **Step 4: Preserve cutover/backfill behavior for older rows by leaving missing speculative values null**

### Task 3: Aggregate and display acceptance rate

**Files:**
- Modify: `src/status-server/metrics.ts`
- Modify: `src/status-server/idle-summary.ts`
- Modify: `src/status-server/dashboard-runs/metrics.ts`
- Modify: `dashboard/src/types.ts`
- Modify: `dashboard/src/tabs/MetricsTab.tsx`

- [ ] **Step 1: Extend runtime metrics totals and idle snapshots with speculative accepted/generated totals**
- [ ] **Step 2: Derive daily acceptance rate from aggregated totals alongside cache hit rate**
- [ ] **Step 3: Add the acceptance-rate graph to the Metrics tab with accepted/generated token series**

### Task 4: Verify the full path

**Files:**
- Modify only if required by failing verification

- [ ] **Step 1: Run the targeted backend and dashboard test suites**
- [ ] **Step 2: Fix any regressions without widening scope**
- [ ] **Step 3: Re-run the same suites to green**
