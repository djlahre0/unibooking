import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "unibooking — Interactive API Explorer",
  description:
    "Interactive Try-It explorer for the unibooking package: stateless, unified CRUD across 16 booking & calendar providers including Google, Outlook, Square, and Acuity.",
  keywords: [
    "unibooking",
    "calendar api",
    "booking api",
    "unified api",
    "scheduling",
    "google calendar",
    "outlook calendar",
    "square booking"
  ],
  authors: [{ name: "djlahre0" }],
  openGraph: {
    title: "unibooking — Interactive API Explorer",
    description: "Stateless, unified CRUD for 16 booking & calendar providers.",
    siteName: "unibooking",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "unibooking — Interactive API Explorer",
    description: "Stateless, unified CRUD for 16 booking & calendar providers.",
  },
  robots: {
    index: true,
    follow: true,
  }
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
