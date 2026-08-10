/* Vite serves `?raw` imports as the file's text. Used by paginator.test.ts to
   evaluate a browser script that has no module interface. */
declare module '*?raw' {
  const content: string;
  export default content;
}
