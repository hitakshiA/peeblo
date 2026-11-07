import { siDocker, siGithub } from "simple-icons";

type IconProps = { className?: string; size?: number };

function Simple({ path, className, size = 16 }: IconProps & { path: string }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} className={className} aria-hidden="true" fill="currentColor">
      <path d={path} />
    </svg>
  );
}

export const GitHubMark = (p: IconProps) => <Simple path={siGithub.path} {...p} />;
export const DockerMark = (p: IconProps) => <Simple path={siDocker.path} {...p} />;

// Slack's mark is not in Simple Icons; a channel hash stands in for it.
export function HashMark({ className, size = 16 }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} className={className} aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
      <path d="M9 3 7 21M17 3l-2 18M4 8.5h17M3 15.5h17" />
    </svg>
  );
}
