import { NextResponse, type NextRequest } from 'next/server';
import { supabaseForRequest } from '../../lib/supabase';
import { ORG_COOKIE } from '../../lib/session';

export async function POST(request: NextRequest): Promise<NextResponse> {
  const supabase = await supabaseForRequest();
  await supabase.auth.signOut();
  const response = NextResponse.redirect(new URL('/login', request.url));
  response.cookies.delete(ORG_COOKIE);
  return response;
}
