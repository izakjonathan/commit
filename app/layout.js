import "./globals.css";

export const metadata = {
  title: "GitHub ZIP Committer",
  description: "Upload ZIP builds to GitHub from mobile."
};

export const viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover"
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
