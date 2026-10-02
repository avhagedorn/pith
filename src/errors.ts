export const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
export const errorCode = (error: unknown) => (error as NodeJS.ErrnoException | undefined)?.code;
