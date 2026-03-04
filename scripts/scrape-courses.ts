#!/usr/bin/env npx tsx
// ============================================================
// Course Scraper — All NYU courses across multiple terms
// ============================================================
// Usage: npx tsx scripts/scrape-courses.ts
//
// Fetches courses from multiple recent semesters to build a
// master catalog. Each course tracks which terms it's offered in.
// ============================================================

const API_URL = "https://bulletins.nyu.edu/class-search/api/?page=fose&route=search";

interface FoseResult {
    code: string;
    title: string;
    key: string;
    srcdb: string;
}

interface CatalogEntry {
    courseId: string;
    title: string;
    department: string;
    embeddingText: string;
    /** Which terms this course has been offered in, e.g. ["1248", "1254", "1258"] */
    termsOffered: string[];
    /** Human-readable term labels */
    termsOfferedLabels: string[];
}

// Terms to scrape — covers 2 full academic years + upcoming
const TERMS = [
    { code: "1244", label: "Spring 2024" },
    { code: "1246", label: "Summer 2024" },
    { code: "1248", label: "Fall 2024" },
    { code: "1254", label: "Spring 2025" },
    { code: "1256", label: "Summer 2025" },
    { code: "1258", label: "Fall 2025" },
    { code: "1264", label: "Spring 2026" },
    { code: "1266", label: "Summer 2026" },
];

async function fetchTerm(termCode: string): Promise<FoseResult[]> {
    const response = await fetch(API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            other: { srcdb: termCode },
            criteria: [],
        }),
    });

    if (!response.ok) {
        console.error(`  ✗ HTTP ${response.status} for term ${termCode}`);
        return [];
    }

    const data = await response.json() as { count: number; results: FoseResult[] };
    return data.results ?? [];
}

async function main() {
    console.log("Scraping ALL NYU courses across multiple terms...\n");

    // Master catalog: courseId → CatalogEntry
    const master = new Map<string, CatalogEntry>();
    let totalSections = 0;

    for (const term of TERMS) {
        console.log(`  Fetching ${term.label} (${term.code})...`);
        const results = await fetchTerm(term.code);
        totalSections += results.length;

        // Deduplicate sections within this term, then merge into master
        const seenThisTerm = new Set<string>();
        let newCourses = 0;
        let updatedCourses = 0;

        for (const r of results) {
            if (seenThisTerm.has(r.code)) continue;
            seenThisTerm.add(r.code);

            const existing = master.get(r.code);
            if (existing) {
                // Course already in master — add this term to its list
                if (!existing.termsOffered.includes(term.code)) {
                    existing.termsOffered.push(term.code);
                    existing.termsOfferedLabels.push(term.label);
                    updatedCourses++;
                }
            } else {
                // New course
                const dept = r.code.replace(/\s+\d+.*$/, "");
                master.set(r.code, {
                    courseId: r.code,
                    title: r.title,
                    department: dept,
                    embeddingText: `${r.code} - ${r.title}. Department: ${dept}.`,
                    termsOffered: [term.code],
                    termsOfferedLabels: [term.label],
                });
                newCourses++;
            }
        }

        const uniqueThisTerm = seenThisTerm.size;
        console.log(`    ${results.length} sections → ${uniqueThisTerm} unique, ${newCourses} new, ${updatedCourses} updated`);

        // Be kind to the API between terms
        await new Promise(resolve => setTimeout(resolve, 500));
    }

    const catalog = Array.from(master.values());

    // Stats
    const depts = new Set(catalog.map(c => c.department));
    console.log(`\n${"─".repeat(60)}`);
    console.log(`Total sections scraped: ${totalSections}`);
    console.log(`Unique courses (master): ${catalog.length}`);
    console.log(`Unique departments: ${depts.size}`);

    // Term coverage stats
    const termCounts = new Map<number, number>();
    for (const c of catalog) {
        const n = c.termsOffered.length;
        termCounts.set(n, (termCounts.get(n) || 0) + 1);
    }
    console.log("\nTerm coverage:");
    for (const [n, count] of Array.from(termCounts.entries()).sort((a, b) => a[0] - b[0])) {
        console.log(`  Offered in ${n} term${n > 1 ? "s" : ""}:  ${count} courses`);
    }

    // Top departments
    const deptCounts = new Map<string, number>();
    for (const c of catalog) {
        deptCounts.set(c.department, (deptCounts.get(c.department) || 0) + 1);
    }
    const topDepts = Array.from(deptCounts.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10);
    console.log("\nTop 10 departments:");
    for (const [dept, count] of topDepts) {
        console.log(`  ${dept.padEnd(15)} ${count} courses`);
    }

    // Save
    const fs = await import("fs");
    const outPath = new URL(
        "../packages/engine/src/data/course_catalog_full.json",
        import.meta.url
    );
    fs.writeFileSync(outPath, JSON.stringify(catalog, null, 2));
    const sizeMB = (fs.statSync(outPath).size / 1024 / 1024).toFixed(1);
    console.log(`\nSaved: ${outPath.pathname} (${sizeMB} MB)`);
}

main().catch(console.error);
