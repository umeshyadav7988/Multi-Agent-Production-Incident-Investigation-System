import type { ReactNode } from 'react';
import './global.css';

export const metadata = {
  title: 'Incident Investigator',
  description:
    'Six agents investigate a simulated production incident over unreliable tools, then report ranked hypotheses with the evidence for and against each one.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
