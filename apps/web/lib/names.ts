// What to call someone in a short line: their first name. "Elena Ruiz" is Elena; "Dr. Ruiz" stays Dr. Ruiz, never
// just "Dr." (a screen once said "Dr.'s own copy").
export const firstName = (name: string) => {
  const words = name.trim().split(/\s+/);
  return /^(dr|mr|mrs|ms|miss|prof|sir|dame)\.?$/i.test(words[0] ?? "") && words[1] ? `${words[0]} ${words[1]}` : words[0] || name;
};
