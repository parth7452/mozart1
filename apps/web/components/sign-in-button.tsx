'use client';
import { useFormStatus } from 'react-dom';

export function SignInButton() {
  const { pending } = useFormStatus();
  return (
    <button className="primary sign-in-button" type="submit" disabled={pending} aria-busy={pending}>
      {pending ? 'Sending your link…' : 'Email me a sign-in link'}
      <span aria-hidden="true">↗</span>
    </button>
  );
}
