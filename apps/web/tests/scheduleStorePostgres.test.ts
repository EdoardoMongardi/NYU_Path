// ============================================================
// Phase 16 Task A — PostgresScheduleStore SQL pattern coverage
// ============================================================
// We don't have a live Neon DB in CI, so we stub the drizzle
// `Database` surface area with a recorder that captures the chain
// of method calls and (where needed) returns canned rows. This
// mirrors how the engine-side InMemoryScheduleStore tests cover
// the *semantics* — these tests cover the *SQL plumbing*: that the
// store calls insert / supersede-update / select / delete on the
// right tables in the right order.
// ============================================================

import { describe, expect, it, beforeEach } from "vitest";
import { PostgresScheduleStore } from "../lib/db/scheduleStorePostgres";
import type { Database } from "../lib/db/client";
import {
    forwardSchedules,
    schedulePreferences,
    students,
} from "../lib/db/schema";
import type { ForwardSchedule, SchedulePreferences } from "@nyupath/shared";

// ---- Stub Database ----
//
// Records every chained method invocation. Each builder method
// returns `this` so the store's chain (`db.insert(t).values(v).onConflictDoUpdate({...})`)
// resolves to a thenable that the store can `await`. The stub also
// supports `db.transaction(cb)` by passing itself in as `tx` so the
// transactional path exercises the same recorder.
// ============================================================

interface RecordedCall {
    op: string;
    args: unknown[];
}

class StubDatabase {
    public readonly calls: RecordedCall[] = [];
    private nextSelectResult: unknown[] = [];

    /** Test-only — rig the next .select(...).limit(N) chain to return these rows. */
    setNextSelectResult(rows: unknown[]): void {
        this.nextSelectResult = rows;
    }

    insert(table: unknown): this {
        this.calls.push({ op: "insert", args: [table] });
        return this;
    }
    values(values: unknown): this {
        this.calls.push({ op: "values", args: [values] });
        return this;
    }
    onConflictDoUpdate(opts: unknown): Promise<unknown> {
        this.calls.push({ op: "onConflictDoUpdate", args: [opts] });
        return Promise.resolve();
    }
    onConflictDoNothing(opts: unknown): Promise<unknown> {
        this.calls.push({ op: "onConflictDoNothing", args: [opts] });
        return Promise.resolve();
    }
    update(table: unknown): this {
        this.calls.push({ op: "update", args: [table] });
        return this;
    }
    set(values: unknown): this {
        this.calls.push({ op: "set", args: [values] });
        return this;
    }
    where(clause: unknown): this {
        this.calls.push({ op: "where", args: [clause] });
        return this;
    }
    select(columns?: unknown): this {
        this.calls.push({ op: "select", args: columns !== undefined ? [columns] : [] });
        return this;
    }
    from(table: unknown): this {
        this.calls.push({ op: "from", args: [table] });
        return this;
    }
    orderBy(clause: unknown): this {
        this.calls.push({ op: "orderBy", args: [clause] });
        return this;
    }
    limit(n: number): Promise<unknown[]> {
        this.calls.push({ op: "limit", args: [n] });
        const result = this.nextSelectResult;
        this.nextSelectResult = [];
        return Promise.resolve(result);
    }
    delete(table: unknown): this {
        this.calls.push({ op: "delete", args: [table] });
        return this;
    }
    /** The store's `where(...)` chain may end on .delete(...).where(...);
     *  the outer await calls .then on the chain. We need that chain to
     *  resolve as a thenable when no further methods are chained. */
    then(onFulfilled?: (v: unknown) => unknown): Promise<unknown> {
        this.calls.push({ op: "then-resolve", args: [] });
        return Promise.resolve(undefined).then(onFulfilled);
    }

    async transaction<T>(cb: (tx: this) => Promise<T>): Promise<T> {
        this.calls.push({ op: "transaction-begin", args: [] });
        const result = await cb(this);
        this.calls.push({ op: "transaction-commit", args: [] });
        return result;
    }
}

function mkSchedule(overrides: Partial<ForwardSchedule> = {}): ForwardSchedule {
    return {
        studentId: "test_student_1",
        homeSchoolId: "cas",
        graduationTerm: "2027-spring",
        creditTargetPerSemester: 16,
        f1Floor: 12,
        domesticPartTimeFloor: 6,
        graduationCreditMinimum: 128,
        degreeCreditsMet: true,
        semesters: [],
        dprCourseHistoryHash: "test:hash",
        computedAt: 1700000000000,
        feasibility: {
            feasible: true,
            constraintViolations: [],
            unmetRequirements: [],
        },
        state: "valid-clean",
        balanceScore: 0,
        assumptions: [],
        ...overrides,
    } as ForwardSchedule;
}

describe("PostgresScheduleStore — persistSchedule", () => {
    let stub: StubDatabase;
    let store: PostgresScheduleStore;

    beforeEach(() => {
        stub = new StubDatabase();
        store = new PostgresScheduleStore(stub as unknown as Database);
    });

    it("opens a transaction, ensures the student row, supersedes prior rows, then inserts the new schedule", async () => {
        const schedule = mkSchedule();
        await store.persistSchedule("stud_1", schedule, "fp_v1");

        const ops = stub.calls.map((c) => c.op);
        // Transaction wraps the whole apply.
        expect(ops[0]).toBe("transaction-begin");
        expect(ops[ops.length - 1]).toBe("transaction-commit");
        // Inside: ensure-student, then supersede, then insert.
        expect(ops).toContain("onConflictDoNothing");
        // Update happens before the insert of the new live row.
        const updIdx = ops.indexOf("update");
        const insertScheduleIdx = ops.lastIndexOf("insert");
        expect(updIdx).toBeGreaterThan(-1);
        expect(insertScheduleIdx).toBeGreaterThan(updIdx);

        // The supersede UPDATE targets forward_schedules.
        const updCall = stub.calls[updIdx]!;
        expect(updCall.args[0]).toBe(forwardSchedules);

        // The schedule INSERT targets forward_schedules with the right values.
        const insertCall = stub.calls[insertScheduleIdx]!;
        expect(insertCall.args[0]).toBe(forwardSchedules);
        const valuesIdx = ops.lastIndexOf("values");
        const valuesCall = stub.calls[valuesIdx]!;
        const inserted = valuesCall.args[0] as Record<string, unknown>;
        expect(inserted.studentId).toBe("stud_1");
        expect(inserted.dprFingerprint).toBe("fp_v1");
        expect(inserted.state).toBe("valid-clean");
    });
});

describe("PostgresScheduleStore — loadLatestSchedule", () => {
    let stub: StubDatabase;
    let store: PostgresScheduleStore;
    beforeEach(() => {
        stub = new StubDatabase();
        store = new PostgresScheduleStore(stub as unknown as Database);
    });

    it("selects from forward_schedules where student matches AND superseded_at is null, ordered by computed_at desc, limit 1", async () => {
        stub.setNextSelectResult([
            { schedule: mkSchedule({ graduationTerm: "2027-spring" }), dprFingerprint: "fp_v1" },
        ]);
        const result = await store.loadLatestSchedule("stud_1");
        expect(result).not.toBeNull();
        expect(result!.dprFingerprint).toBe("fp_v1");
        expect(result!.schedule.graduationTerm).toBe("2027-spring");

        const ops = stub.calls.map((c) => c.op);
        expect(ops).toEqual(["select", "from", "where", "orderBy", "limit"]);
        // Confirm we read from forward_schedules.
        expect(stub.calls[1]!.args[0]).toBe(forwardSchedules);
        // limit(1) is the canonical "latest row" pattern.
        expect(stub.calls[4]!.args[0]).toBe(1);
    });

    it("returns null when no rows match", async () => {
        stub.setNextSelectResult([]);
        const result = await store.loadLatestSchedule("stud_1");
        expect(result).toBeNull();
    });
});

describe("PostgresScheduleStore — preferences", () => {
    let stub: StubDatabase;
    let store: PostgresScheduleStore;
    beforeEach(() => {
        stub = new StubDatabase();
        store = new PostgresScheduleStore(stub as unknown as Database);
    });

    it("persistPreferences upserts on student_id with onConflictDoUpdate", async () => {
        const prefs: SchedulePreferences = { loadStyle: "balanced" };
        await store.persistPreferences("stud_1", prefs);
        const ops = stub.calls.map((c) => c.op);
        // First: ensure-student row, then upsert preferences.
        expect(ops).toContain("onConflictDoNothing");
        expect(ops).toContain("onConflictDoUpdate");
        const upsertIdx = ops.indexOf("onConflictDoUpdate");
        const upsertCall = stub.calls[upsertIdx]!;
        const upsertOpts = upsertCall.args[0] as { target: unknown };
        expect(upsertOpts.target).toBe(schedulePreferences.studentId);
    });

    it("loadPreferences returns the preferences JSONB or null", async () => {
        stub.setNextSelectResult([{ preferences: { loadStyle: "frontload" } }]);
        const out = await store.loadPreferences("stud_1");
        expect(out).toEqual({ loadStyle: "frontload" });

        // Empty result → null.
        stub.setNextSelectResult([]);
        const out2 = await store.loadPreferences("stud_2");
        expect(out2).toBeNull();
    });
});

describe("PostgresScheduleStore — clearScheduleForStudent", () => {
    it("deletes from forward_schedules where studentId matches", async () => {
        const stub = new StubDatabase();
        const store = new PostgresScheduleStore(stub as unknown as Database);
        await store.clearScheduleForStudent("stud_1");
        const ops = stub.calls.map((c) => c.op);
        expect(ops[0]).toBe("delete");
        expect(stub.calls[0]!.args[0]).toBe(forwardSchedules);
        expect(ops).toContain("where");
    });
});

// Touch the import so vitest doesn't tree-shake it.
void students;
