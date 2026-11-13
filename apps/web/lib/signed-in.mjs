// Who is signed in, for pages on the server. A moment where the sign-in service cannot be reached is not the same as
// being signed out: treating it so sent people to the sign-in page while their sign-in was still good. Kept plain
// JavaScript so its check runs with no build.

// Supabase marks a failure to reach its sign-in service as retryable; anything else (no session, a bad or ended one)
// means nobody is signed in.
function unreachable(error) {
  return !!error && error.name === "AuthRetryableFetchError";
}

export async function signedInUser(supabase, { pause = 400 } = {}) {
  for (let tries = 0; ; tries++) {
    const { data, error } = await supabase.auth.getUser();
    if (data?.user) return data.user;
    if (!unreachable(error)) return null;
    // Still unreachable after a second try: a fault to show, never a sign-out.
    if (tries >= 1) throw new Error("The sign-in service could not be reached");
    await new Promise((done) => setTimeout(done, pause));
  }
}

// For pages that only show something different when signed in: a fault there just shows them as signed out.
export async function signedInOrNull(supabase) {
  try {
    return await signedInUser(supabase);
  } catch {
    return null;
  }
}
