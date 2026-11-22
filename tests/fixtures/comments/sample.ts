/// <reference types="node" />

type Point = { x: number; y: number }; // counts

// @ts-ignore missing types
import legacy from 'legacy';
// @ts-expect-error wrong on purpose
const p: Point = legacy('/* not a comment */');
export default p;
