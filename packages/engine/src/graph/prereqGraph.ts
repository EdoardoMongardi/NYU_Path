// ============================================================
// Prerequisite Graph — DAG operations
// ============================================================
import type { Prerequisite, PrereqGroup } from "@nyupath/shared";

export class PrereqGraph {
    /** course → prerequisite definition */
    private prereqMap: Map<string, Prerequisite>;

    /** course → list of courses it unlocks (reverse edges) */
    private reverseMap: Map<string, Set<string>>;

    constructor(prereqs: Prerequisite[]) {
        this.prereqMap = new Map();
        this.reverseMap = new Map();

        for (const p of prereqs) {
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
        const prereq = this.prereqMap.get(courseId);
        if (!prereq) return true; // no prerequisites

        return prereq.prereqGroups.every((group) =>
            this.isGroupSatisfied(group, completedCourses)
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
        return allCourseIds.filter(
            (id) =>
                !completedCourses.has(id) &&
                this.hasPrerequisitesMet(id, completedCourses)
        );
    }

    /**
     * Get the prerequisites for a course.
     */
    getPrereqs(courseId: string): Prerequisite | undefined {
        return this.prereqMap.get(courseId);
    }

    /**
     * Get corequisites for a course.
     */
    getCoreqs(courseId: string): string[] {
        return this.prereqMap.get(courseId)?.coreqs ?? [];
    }

    /**
     * Get all courses that this course unlocks (direct dependents).
     */
    getDependents(courseId: string): string[] {
        return [...(this.reverseMap.get(courseId) ?? [])];
    }

    /**
     * Count how many future courses are transitively blocked if this course
     * is not yet taken. Higher = more critical to take soon.
     */
    countTransitivelyBlocked(courseId: string): number {
        const blocked = new Set<string>();
        const queue = [courseId];

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

    private isGroupSatisfied(
        group: PrereqGroup,
        completedCourses: Set<string>
    ): boolean {
        if (group.type === "AND") {
            return group.courses.every((c) => completedCourses.has(c));
        } else {
            // OR
            return group.courses.some((c) => completedCourses.has(c));
        }
    }
}
