type FolderProps = {
  className?: string;
  width?: number;
  height?: number;
};

export const Folder = ({ className = '', width, height }: FolderProps) => {
  return (
    <svg
      className={className}
      width={width}
      height={height}
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2"
        d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"
      ></path>
    </svg>
  );
};
