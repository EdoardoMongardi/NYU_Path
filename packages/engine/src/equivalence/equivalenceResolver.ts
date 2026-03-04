// ============================================================
// Equivalence Module — Cross-listed & exclusion resolver
// ============================================================
import type { Course } from "@nyupath/shared";

export class EquivalenceResolver {
    /** Map course ID → its canonical ID (the "primary" in a cross-listed group) */
    private canonicalMap: Map<string, string>;

    /** Map course ID → all exclusions */
    private exclusionMap: Map<string, Set<string>>;

    constructor(courses: Course[]) {
        this.canonicalMap = new Map();
        this.exclusionMap = new Map();

        // Build cross-listing groups: use the alphabetically first ID as canonical
        for (const course of courses) {
            if (course.crossListed.length > 0) {
                const group = [course.id, ...course.crossListed].sort();
                const canonical = group[0];
                for (const id of group) {
                    this.canonicalMap.set(id, canonical);
                }
            }
        }

        // Build exclusion map
        for (const course of courses) {
            if (course.exclusions.length > 0) {
                this.exclusionMap.set(course.id, new Set(course.exclusions));
                // Also set reverse exclusions
                for (const excl of course.exclusions) {
                    if (!this.exclusionMap.has(excl)) {
                        this.exclusionMap.set(excl, new Set());
                    }
                    this.exclusionMap.get(excl)!.add(course.id);
                }
            }
        }
    }

    /**
     * Resolve a course ID to its canonical form.
     * If a student took DS-UA 301, it resolves to the same canonical as CSCI-UA 471.
     */
    getCanonical(courseId: string): string {
        return this.canonicalMap.get(courseId) ?? courseId;
    }

    /**
     * Check if two courses are cross-listed equivalents.
     */
    areCrossListed(a: string, b: string): boolean {
        return this.getCanonical(a) === this.getCanonical(b) && a !== b;
    }

    /**
     * Check if two courses are mutually exclusive.
     * (e.g., CSCI-UA 101 and CSCI-UA 110 — student takes one intro track)
     */
    areExclusive(a: string, b: string): boolean {
        return this.exclusionMap.get(a)?.has(b) ?? false;
    }

    /**
     * Normalize a set of completed courses:
     * - Deduplicate cross-listed courses (keep canonical)
     * - Generate warnings for exclusion violations
     */
    normalizeCompleted(courseIds: string[]): {
        normalized: Set<string>;
        warnings: string[];
    } {
        const warnings: string[] = [];
        const normalized = new Set<string>();
        const seenCanonicals = new Map<string, string>(); // canonical → original ID

        for (const id of courseIds) {
            const canonical = this.getCanonical(id);

            // Check for cross-listed duplicates
            if (seenCanonicals.has(canonical) && seenCanonicals.get(canonical) !== id) {
                const previous = seenCanonicals.get(canonical)!;
                warnings.push(
                    `${id} is cross-listed with ${previous}; counted only once as ${canonical}`
                );
                continue; // skip the duplicate
            }

            // Check for exclusion violations
            for (const existing of normalized) {
                if (this.areExclusive(id, existing)) {
                    warnings.push(
                        `${id} and ${existing} are mutually exclusive; both taken but only one may count toward CS requirements`
                    );
                }
            }

            seenCanonicals.set(canonical, id);
            normalized.add(id);
        }

        return { normalized, warnings };
    }

    /**
     * Check if a course ID (or any of its cross-listed equivalents) is in a set.
     */
    isInSet(courseId: string, courseSet: Set<string>): boolean {
        if (courseSet.has(courseId)) return true;
        const canonical = this.getCanonical(courseId);
        for (const id of courseSet) {
            if (this.getCanonical(id) === canonical) return true;
        }
        return false;
    }
}
