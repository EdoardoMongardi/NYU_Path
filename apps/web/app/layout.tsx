import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "NYU Path — AI Course Planner",
  description: "Plan your NYU degree with AI. Upload your transcript, get personalized course recommendations.",
  icons: {
    icon: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='0.9em' font-size='90'>🎓</text></svg>",
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
