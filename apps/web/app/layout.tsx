import type { ReactNode } from 'react';
import './globals.css';

export const metadata = {
  title: 'Recouple',
  description: 'Deductions recovery: a reviewer approves, then it is submitted.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
