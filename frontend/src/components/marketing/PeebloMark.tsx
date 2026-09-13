/** A little pebble-shaped P, shared by the brand and its on-screen teammate. */
export default function PeebloMark({ size = 28 }: { size?: number }) {
  return (
    <svg
      viewBox="0 0 36 36"
      width={size}
      height={size}
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M7 28V15C7 7.5 11.5 4 19 4C26 4 31 8.5 31 15.5C31 23 26 27 19 27H14V28C14 33 7 33 7 28Z"
        fill="currentColor"
      />
      <ellipse cx="17" cy="13" rx="1.5" ry="2" fill="#10130f" />
      <ellipse cx="24" cy="13" rx="1.5" ry="2" fill="#10130f" />
      <path
        d="M17.5 18C19 20 22 20 23.5 18"
        stroke="#10130f"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}
