// A small module.
#![allow(dead_code)]

/// Adds numbers.
fn add(a: i32, b: i32) -> i32 {
    let s = "// not a comment";
    #[allow(unused_variables)]
    let unused = 1; /* trailing */
    a + b
}
