// ============================================================
// Prerequisite Graph — DAG operations
// ============================================================
import type { Prerequisite, PrereqGroup } from "@nyupath/shared";
import { canonicalizeCourseId, canonicalizeCourseIdSet } from "../courseId.js";

export class PrereqGraph {
    /** course → prerequisite definition (ids canonicalized) */
    private prereqMap: Map<string, Prerequisite>;

    /** course → list of courses it unlocks (reverse edges) */
    private reverseMap: Map<string, Set<string>>;

    constructor(prereqs: Prerequisite[]) {
        this.prereqMap = new Map();
        this.reverseMap = new Map();

        for (const raw of prereqs) {
            // Canonicalize every id so "CSCI-UA 0101" and "CSCI-UA 101"
            // (the same course written two ways) compare equal against the
            // student's completed-course ids. Done at construction so the
            // whole graph is form-agnostic regardless of the source data.
            const p = canonicalizePrereq(raw);
            this.prereqMap.set(p.course, p);
            // Build reverse edges
            for (const group of p.prereqGroups) {
                for (const courseId of group.courses) {
                    if (!this.reverseMap.has(courseId)) {
                        this.reverseMap.set(courseId, new Set());
                    }
                    this.reverseMap.get(courseId)!.add(p.course);
                }
            }
        }
    }

    /**
     * Validate no cycles in the prerequisite graph.
     * Returns list of cycles found (empty = valid DAG).
     */
    detectCycles(): string[][] {
        const visited = new Set<string>();
        const inStack = new Set<string>();
        const cycles: string[][] = [];

        const dfs = (node: string, path: string[]) => {
            if (inStack.has(node)) {
                // Found cycle: extract it
                const cycleStart = path.indexOf(node);
                cycles.push(path.slice(cycleStart));
                return;
            }
            if (visited.has(node)) return;

            visited.add(node);
            inStack.add(node);
            path.push(node);

            const prereq = this.prereqMap.get(node);
            if (prereq) {
                for (const group of prereq.prereqGroups) {
                    for (const dep of group.courses) {
                        dfs(dep, [...path]);
                    }
                }
            }

            inStack.delete(node);
        };

        for (const course of this.prereqMap.keys()) {
            dfs(course, []);
        }

        return cycles;
    }

    /**
     * Check if a student has met the prerequisites for a course.
     * All prereqGroups must be satisfied:
     *   - AND group: ALL courses in the group must be completed
     *   - OR group: AT LEAST ONE course in the group must be completed
     */
    hasPrerequisitesMet(courseId: string, completedCourses: Set<string>): boolean {
        return this._hasPrereqMet(
            canonicalizeCourseId(courseId),
            canonicalizeCourseIdSet(completedCourses),
        );
    }

    /** Internal: assumes already-canonicalized inputs (the graph's keys
     *  and the completed set are both canonical). */
    private _hasPrereqMet(canonCourseId: string, canonCompleted: Set<string>): boolean {
        const prereq = this.prereqMap.get(canonCourseId);
        if (!prereq) return true; // no prerequisites
        return prereq.prereqGroups.every((group) =>
            this.isGroupSatisfied(group, canonCompleted)
        );
    }

    /**
     * Get all courses that are now unlocked given completed courses.
     * A course is unlocked if:
     *   1. It has not been completed yet
     *   2. All its prerequisite groups are satisfied
     */
    getUnlockedCourses(
        completedCourses: Set<string>,
        allCourseIds: string[]
    ): string[] {
        const cc = canonicalizeCourseIdSet(completedCourses);
        return allCourseIds.filter((id) => {
            const c = canonicalizeCourseId(id);
            return !cc.has(c) && this._hasPrereqMet(c, cc);
        });
    }

    /**
     * Get the prerequisites for a course.
     */
    getPrereqs(courseId: string): Prerequisite | undefined {
        return this.prereqMap.get(canonicalizeCourseId(courseId));
    }

    /**
     * Get corequisites for a course.
     */
    getCoreqs(courseId: string): string[] {
        return this.prereqMap.get(canonicalizeCourseId(courseId))?.coreqs ?? [];
    }

    /**
     * Get all courses that this course unlocks (direct dependents).
     */
    getDependents(courseId: string): string[] {
        return [...(this.reverseMap.get(canonicalizeCourseId(courseId)) ?? [])];
    }

    /**
     * Count how many future courses are transitively blocked if this course
     * is not yet taken. Higher = more critical to take soon.
     *
     * Note: this is the static graph count — it ignores what the student
     * has already completed. Use `countMarginallyBlocked` when the question
     * is "how much would adding this specific course UNLOCK for THIS student".
     */
    countTransitivelyBlocked(courseId: string): number {
        const blocked = new Set<string>();
        const queue = [canonicalizeCourseId(courseId)];

        while (queue.length > 0) {
            const current = queue.pop()!;
            const deps = this.reverseMap.get(current);
            if (deps) {
                for (const dep of deps) {
                    if (!blocked.has(dep)) {
                        blocked.add(dep);
                        queue.push(dep);
                    }
                }
            }
        }

        return blocked.size;
    }

    /**
     * Marginal unlock count: how many downstream courses are NOT YET unlocked
     * for the student under `completedCourses`, but WOULD be unlocked once
     * `courseId` is added to that set.
     *
     * This is the right measure for the planner's "blocked" priority signal.
     * `countTransitivelyBlocked` over-counts when an alternative course
     * (e.g., CSCI-UA 101 vs. 110, which are an OR-prereq for many CSCI-UA
     * courses) has already been completed — both 101 and 110 list 18+
     * dependents in the static graph, but once 101 is done, 110 unlocks
     * nothing additional.
     */
    countMarginallyBlocked(
        courseId: string,
        completedCourses: Set<string>,
    ): number {
        const canonCourseId = canonicalizeCourseId(courseId);
        const completed = canonicalizeCourseIdSet(completedCourses);
        if (completed.has(canonCourseId)) return 0;

        // Iterative fixed-point expansion. Keep adding courses to the
        // "would-be-completed" frontier until nothing new unlocks.
        const wouldBeComplete = new Set(completed);
        wouldBeComplete.add(canonCourseId);

        // Newly unlocked courses (not previously unlocked but now are)
        const newlyUnlocked = new Set<string>();

        // Restrict the BFS to the transitive-dependents subgraph rooted at
        // `courseId` — anything outside it can't be affected.
        const reachable = new Set<string>();
        const queue = [canonCourseId];
        while (queue.length > 0) {
            const current = queue.pop()!;
            const deps = this.reverseMap.get(current);
            if (!deps) continue;
            for (const dep of deps) {
                if (!reachable.has(dep)) {
                    reachable.add(dep);
                    queue.push(dep);
                }
            }
        }

        let changed = true;
        while (changed) {
            changed = false;
            for (const candidate of reachable) {
                if (newlyUnlocked.has(candidate)) continue;
                if (completed.has(candidate)) continue;
                // Was it already unlocked WITHOUT `courseId`? If yes, doesn't count.
                // `candidate` comes from reverseMap → already canonical.
                const alreadyUnlocked = this._hasPrereqMet(candidate, completed);
                if (alreadyUnlocked) continue;
                // Is it unlocked NOW (with `courseId` and prior unlocks added)?
                if (this._hasPrereqMet(candidate, wouldBeComplete)) {
                    newlyUnlocked.add(candidate);
                    wouldBeComplete.add(candidate);
                    changed = true;
                }
            }
        }

        return newlyUnlocked.size;
    }

    private isGroupSatisfied(
        group: PrereqGroup,
        completedCourses: Set<string>
    ): boolean {
        if (group.type === "AND") {
            return group.courses.every((c) => completedCourses.has(c));
        }
        if (group.type === "OR") {
            return group.courses.some((c) => completedCourses.has(c));
        }
        return (group.notCourses ?? []).every((c) => !completedCourses.has(c));
    }
}

/** Return a copy of a Prerequisite with every course id canonicalized
 *  (course key, every group's courses/notCourses, coreqs, and minGrades
 *  keys). Dedupes ids that collapse to the same canonical form within a
 *  group (e.g. a group listing both "X 0101" and "X 101"). */
function canonicalizePrereq(p: Prerequisite): Prerequisite {
    const canon = canonicalizeCourseId;
    const uniq = (ids: string[]): string[] => [...new Set(ids.map(canon))];
    const out: Prerequisite = {
        ...p,
        course: canon(p.course),
        prereqGroups: p.prereqGroups.map((g) => ({
            ...g,
            courses: uniq(g.courses),
            ...(g.notCourses ? { notCourses: uniq(g.notCourses) } : {}),
        })),
        coreqs: uniq(p.coreqs ?? []),
    };
    if (p.minGrades) {
        const mg: Record<string, string> = {};
        for (const [k, v] of Object.entries(p.minGrades)) mg[canon(k)] = v;
        out.minGrades = mg;
    }
    return out;
}
