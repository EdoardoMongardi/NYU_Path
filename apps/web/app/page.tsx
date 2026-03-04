import styles from "./page.module.css";
import Link from "next/link";

export default function Home() {
  return (
    <div className={styles.page}>
      {/* Nav */}
      <nav className={styles.nav}>
        <div className={styles.navInner}>
          <span className={styles.logo}>🎓 NYU Path</span>
          <Link href="/chat" className={styles.navCta}>Get Started</Link>
        </div>
      </nav>

      {/* Hero */}
      <section className={styles.hero}>
        <div className={styles.heroBadge}>AI-Powered Course Planning</div>
        <h1 className={styles.heroTitle}>
          Plan your NYU degree
          <br />
          <span className={styles.heroAccent}>with AI</span>
        </h1>
        <p className={styles.heroSubtitle}>
          Upload your transcript, get personalized course recommendations,
          and track your degree progress — all in one conversation.
        </p>
        <div className={styles.heroCtas}>
          <Link href="/chat" className={styles.ctaPrimary}>
            Start Planning →
          </Link>
        </div>
      </section>

      {/* Features */}
      <section className={styles.features}>
        <div className={styles.featureGrid}>
          <div className={styles.featureCard}>
            <div className={styles.featureIcon}>📋</div>
            <h3>Transcript Upload</h3>
            <p>Drop your unofficial transcript PDF and watch as AI parses every course, credit, and grade in seconds.</p>
          </div>
          <div className={styles.featureCard}>
            <div className={styles.featureIcon}>🔍</div>
            <h3>Smart Course Search</h3>
            <p>Search 13,000+ NYU courses by interest. &ldquo;I want courses about machine learning&rdquo; — and get ranked results instantly.</p>
          </div>
          <div className={styles.featureCard}>
            <div className={styles.featureIcon}>📊</div>
            <h3>Degree Tracking</h3>
            <p>See exactly how many credits you need, which requirements are left, and whether you&apos;re on track to graduate.</p>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className={styles.footer}>
        <p>Built for NYU students. Not affiliated with New York University.</p>
      </footer>
    </div>
  );
}
