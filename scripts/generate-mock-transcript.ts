import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { writeFileSync } from 'fs';
import { join } from 'path';

async function generateMockTranscript() {
    const pdfDoc = await PDFDocument.create();
    const timesRomanFont = await pdfDoc.embedFont(StandardFonts.TimesRoman);
    const timesBoldFont = await pdfDoc.embedFont(StandardFonts.TimesRomanBold);

    const page = pdfDoc.addPage([612, 792]); // Letter size
    const { height } = page.getSize();

    let currentY = height - 40;

    const drawText = (text: string, x: number, y: number, font = timesRomanFont, size = 9) => {
        page.drawText(text, { x, y, font, size, color: rgb(0, 0, 0) });
    };

    const drawLine = (y: number) => {
        page.drawLine({ start: { x: 40, y }, end: { x: 570, y }, thickness: 0.5, color: rgb(0.5, 0.5, 0.5) });
    };

    // ── Header ──
    drawText('New York University', 40, currentY, timesBoldFont, 13);
    currentY -= 14;
    drawText('Unofficial Academic Transcript', 40, currentY, timesBoldFont, 10);
    currentY -= 20;
    drawLine(currentY);
    currentY -= 12;

    // ── Student Info ──
    drawText('Name:  Mock Student', 40, currentY, timesRomanFont, 9);
    drawText('ID:  N12345678', 300, currentY, timesRomanFont, 9);
    currentY -= 13;
    drawText('Degree:  Bachelor of Arts', 40, currentY, timesRomanFont, 9);
    drawText('School:  College of Arts and Science', 300, currentY, timesRomanFont, 9);
    currentY -= 13;
    drawText('Major:  Computer Science', 40, currentY, timesRomanFont, 9);
    drawText('Expected Graduation:  May 2026', 300, currentY, timesRomanFont, 9);
    currentY -= 18;
    drawLine(currentY);
    currentY -= 12;

    type Course = {
        id: string;
        title: string;
        credits: number;
        grade: string;
    };

    type Semester = {
        term: string;
        school: string;
        courses: Course[];
        termGPA: number;
        termCredits: number;
        cumGPA: number;
        cumCredits: number;
    };

    const semesters: Semester[] = [
        {
            term: 'Fall 2022',
            school: 'College of Arts and Science',
            courses: [
                { id: 'CSCI-UA 101', title: 'Introduction to Computer Science', credits: 4, grade: 'A' },
                { id: 'MATH-UA 121', title: 'Calculus I', credits: 4, grade: 'A-' },
                { id: 'EXPOS-UA 1', title: 'Writing as Inquiry', credits: 4, grade: 'B+' },
                { id: 'CORE-UA 500', title: 'Texts and Ideas (Representative)', credits: 4, grade: 'A' },
            ],
            termGPA: 3.77, termCredits: 16, cumGPA: 3.77, cumCredits: 16,
        },
        {
            term: 'Spring 2023',
            school: 'College of Arts and Science',
            courses: [
                { id: 'CSCI-UA 102', title: 'Data Structures', credits: 4, grade: 'A' },
                { id: 'MATH-UA 122', title: 'Calculus II', credits: 4, grade: 'B+' },
                { id: 'CORE-UA 100', title: 'Quantitative Reasoning: Problems, Statistics, & Decision Making', credits: 4, grade: 'A-' },
                { id: 'CORE-UA 600', title: 'Cultures and Contexts (Representative)', credits: 4, grade: 'A' },
            ],
            termGPA: 3.81, termCredits: 16, cumGPA: 3.79, cumCredits: 32,
        },
        {
            term: 'Fall 2023',
            school: 'College of Arts and Science',
            courses: [
                { id: 'CSCI-UA 201', title: 'Computer Systems Organization', credits: 4, grade: 'A-' },
                { id: 'CSCI-UA 310', title: 'Basic Algorithms', credits: 4, grade: 'B+' },
                { id: 'MATH-UA 140', title: 'Linear Algebra', credits: 4, grade: 'A' },
                { id: 'CORE-UA 700', title: 'Societies and the Social Sciences (Representative)', credits: 4, grade: 'A-' },
            ],
            termGPA: 3.58, termCredits: 16, cumGPA: 3.72, cumCredits: 48,
        },
        {
            term: 'Spring 2024',
            school: 'College of Arts and Science',
            courses: [
                { id: 'CSCI-UA 202', title: 'Operating Systems', credits: 4, grade: 'A' },
                { id: 'MATH-UA 120', title: 'Discrete Mathematics', credits: 4, grade: 'A' },
                { id: 'MATH-UA 233', title: 'Theory of Probability', credits: 4, grade: 'B+' },
                { id: 'FREN-UA 12', title: 'French Intermediate II', credits: 4, grade: 'A-' },
            ],
            termGPA: 3.77, termCredits: 16, cumGPA: 3.73, cumCredits: 64,
        },
        {
            term: 'Fall 2024',
            school: 'College of Arts and Science',
            courses: [
                { id: 'CSCI-UA 467', title: 'Applied Internet Technology', credits: 4, grade: '***' },
                { id: 'CSCI-UA 480', title: 'Special Topics in Computer Science', credits: 4, grade: '***' },
                { id: 'CSCI-UA 473', title: 'Fundamentals of Machine Learning', credits: 4, grade: '***' },
            ],
            termGPA: 0.0, termCredits: 0, cumGPA: 3.73, cumCredits: 64,
        },
    ];

    for (const sem of semesters) {
        // Semester header
        drawText(`Term: ${sem.term}`, 40, currentY, timesBoldFont, 9);
        drawText(`School: ${sem.school}`, 300, currentY, timesBoldFont, 9);
        currentY -= 12;
        drawText('Major: Computer Science   Degree: Bachelor of Arts', 40, currentY, timesRomanFont, 8);
        currentY -= 11;

        // Column headers
        drawText('Course ID', 40, currentY, timesBoldFont, 8);
        drawText('Title', 130, currentY, timesBoldFont, 8);
        drawText('Credits', 440, currentY, timesBoldFont, 8);
        drawText('Grade', 510, currentY, timesBoldFont, 8);
        currentY -= 10;

        for (const c of sem.courses) {
            drawText(c.id, 40, currentY, timesRomanFont, 8);
            drawText(c.title, 130, currentY, timesRomanFont, 8);
            drawText(c.credits.toFixed(1), 440, currentY, timesRomanFont, 8);
            drawText(c.grade, 510, currentY, timesRomanFont, 8);
            currentY -= 10;
        }

        // Term totals
        currentY -= 2;
        if (sem.termGPA > 0) {
            drawText(
                `Term GPA: ${sem.termGPA.toFixed(2)}   Term Credits: ${sem.termCredits.toFixed(1)}   Cum GPA: ${sem.cumGPA.toFixed(2)}   Cum Credits: ${sem.cumCredits.toFixed(1)}`,
                40, currentY, timesBoldFont, 8
            );
        } else {
            drawText(
                `Cum GPA: ${sem.cumGPA.toFixed(2)}   Cum Credits: ${sem.cumCredits.toFixed(1)}  (Current semester — grades pending)`,
                40, currentY, timesBoldFont, 8
            );
        }
        currentY -= 14;
        drawLine(currentY);
        currentY -= 12;
    }

    // ── Final totals ──
    drawText('ACADEMIC SUMMARY', 40, currentY, timesBoldFont, 10);
    currentY -= 13;
    drawText('Cumulative GPA:  3.73', 40, currentY, timesRomanFont, 9);
    drawText('Total Credits Earned:  64.0', 300, currentY, timesRomanFont, 9);
    currentY -= 13;
    drawText('Credits In Progress:  12.0', 40, currentY, timesRomanFont, 9);

    const pdfBytes = await pdfDoc.save();
    const filePath = join('/Users/edoardomongardi/Desktop/Ideas/NYU Path', 'mock_cs_transcript.pdf');
    writeFileSync(filePath, pdfBytes);
    console.log(`Mock transcript generated at: ${filePath}`);
}

generateMockTranscript().catch(console.error);
