# Computer Science Basics

This document introduces the core building blocks that beginning programmers use
every day: variables, conditionals, loops, functions, recursion, common data
structures, sorting, string processing, and the idea of algorithmic complexity.
Each section is written to stand on its own so that questions can be drawn from
it directly.

## Variables and Values

A variable is a named place in a program's memory that holds a value. When you
write `count = 0`, you are asking the computer to reserve some memory, store the
value zero in it, and remember that the name `count` refers to that location.
Later, when you write `count = count + 1`, the program reads the current value,
adds one to it, and stores the result back in the same place.

Values have types. An integer such as `42` is a whole number. A floating-point
number such as `3.14` can represent fractions. A string such as `"hello"` is a
sequence of characters. A boolean is either true or false. The type of a value
determines what operations are legal: you can divide two numbers, but dividing
two strings is meaningless and will usually cause an error.

A common beginner mistake is to confuse assignment with equality. In most
languages a single equals sign assigns a value, while a double equals sign tests
whether two values are equal. Writing `if (x = 5)` when you meant `if (x == 5)`
is a classic bug.

## Conditionals

A conditional lets a program choose between different actions depending on
whether a condition is true or false. The most common form is the if-statement.
When the condition evaluates to true, the code inside the if-block runs;
otherwise it is skipped. An else-block provides an alternative action for when
the condition is false.

Conditions are built from comparisons such as greater-than, less-than, and
equality, and they can be combined with the logical operators and, or, and not.
The expression `age >= 13 and age <= 19` is true only when both comparisons hold,
which is how you would test whether someone is a teenager.

Order matters when you chain conditions together with else-if. The program checks
each condition in turn and runs the first block whose condition is true, skipping
all the rest. Putting a more general condition before a more specific one can
therefore hide the specific case, because the general condition captures the
value first.

## Loops

A loop repeats a block of code more than once, which lets a short program do a
large amount of work. The two most common kinds are the while-loop and the
for-loop. A while-loop keeps repeating as long as its condition remains true and
checks that condition before each pass. A for-loop is normally used when you know
in advance how many times you want to repeat, for example once for each item in a
list.

Every loop needs a way to end. A while-loop that never changes the variable in
its condition will run forever; this is called an infinite loop. To avoid it, the
body of the loop must make progress towards making the condition false, usually
by incrementing a counter or shrinking the data still to be processed.

The number of times a loop runs is called the number of iterations. If a loop
runs once for each of the n items in a list, we say it performs n iterations. A
loop placed inside another loop is called a nested loop; if the outer loop runs n
times and the inner loop runs n times for each outer pass, the inner body runs n
times n, which is n squared times in total.

## Functions

A function is a named, reusable block of code that performs a specific task. You
define it once and then call it as many times as you need. Functions take inputs,
called parameters, and usually return an output value. Grouping code into
functions reduces repetition and makes a program easier to read and to test,
because each function can be understood and checked on its own.

When a function is called, the program pauses the current work, runs the
function's body with the given arguments, and then continues from where it left
off using the returned value. Variables created inside a function are local to
that function: they exist only while the function runs and cannot be seen from
outside it. This idea, called scope, is what stops two functions from
accidentally overwriting each other's temporary values.

A well-designed function does one thing and does it well. If a function is trying
to do several unrelated jobs, it is usually better to split it into smaller
functions, each with a clear name that describes what it returns.

## Recursion

Recursion is when a function calls itself to solve a smaller version of the same
problem. A recursive function has two essential parts: a base case that can be
answered directly without further recursion, and a recursive case that reduces
the problem and calls the function again. The classic example is the factorial:
the factorial of n is n times the factorial of n minus one, and the factorial of
zero is defined to be one, which is the base case.

The base case is what stops the recursion. If a recursive function has no base
case, or never actually reaches it, it will call itself endlessly until the
program runs out of memory for tracking the calls. This failure is called a stack
overflow, because each pending call is stored on a region of memory called the
call stack.

Many problems are naturally recursive. Walking through a folder that contains
other folders, or processing a tree in which each node has child nodes, is often
far simpler to express with recursion than with loops. Any recursive solution can
in principle be rewritten using a loop and an explicit stack, but the recursive
version is frequently the clearer one to read.

## Sorting

Sorting means arranging a collection of items into a defined order, such as
numbers from smallest to largest. Sorting is one of the most studied problems in
computer science because so many other tasks, like searching, become much easier
once the data is sorted.

A simple sorting method is bubble sort. It repeatedly steps through the list,
compares each pair of neighbouring items, and swaps them if they are in the wrong
order. After each full pass the largest remaining item has bubbled up to its
correct position at the end. Bubble sort is easy to understand but slow: on a list
of n items it may perform on the order of n squared comparisons, which becomes
impractical for large lists.

More efficient methods such as merge sort and quicksort use a divide-and-conquer
strategy. Merge sort splits the list into halves, sorts each half, and then merges
the two sorted halves back together. Because the splitting halves the problem each
time and merging is linear, merge sort runs in about n times log n time, which is
dramatically faster than n squared when n is large.

## Strings

A string is a sequence of characters, such as letters, digits, and spaces, used
to represent text. Each character in a string has a position called an index, and
in most languages indexing starts at zero, so the first character is at index
zero and the last character of a string of length n is at index n minus one.

Common string operations include finding the length, joining two strings together
end to end, which is called concatenation, and taking a slice, which is a portion
of the string between two indices. Because strings are so common, most languages
provide built-in operations to search for a substring, replace one piece of text
with another, and change the case of letters.

In many languages strings are immutable, meaning that once a string is created it
cannot be changed in place. Operations that appear to modify a string, such as
converting it to upper case, actually create and return a brand new string and
leave the original untouched. Understanding immutability explains why building a
long string by repeated concatenation inside a loop can be surprisingly slow.

## Data Structures

A data structure is a way of organising data so that it can be used efficiently.
Choosing the right data structure often matters more for performance than any
other single decision in a program.

An array, or list, stores items in order and lets you reach any item instantly if
you know its index. Arrays are excellent for reading by position but can be slow
when you need to insert or remove an item in the middle, because the other items
must shift to make room or close the gap. A stack stores items in last-in,
first-out order: the last item you push on is the first one you pop off, like a
stack of plates. A queue works in first-in, first-out order, like people waiting
in line, so the first item added is the first one removed.

A dictionary, also called a map or hash table, stores pairs of keys and values
and lets you look up a value by its key almost instantly. Dictionaries are ideal
when you need to associate one piece of information with another, such as mapping
a student id to a student record, without scanning the whole collection.

## Complexity

Algorithmic complexity describes how the work an algorithm does grows as the size
of its input grows. We usually care about the worst case and we express it with
big-O notation, which keeps only the dominant term and ignores constant factors.

An algorithm that takes the same time no matter how big the input is runs in
constant time, written O(1); looking up a value in a dictionary is a good example.
An algorithm that looks at each item once runs in linear time, O(n). A pair of
nested loops over the same data typically runs in quadratic time, O(n squared),
which grows quickly and becomes slow for large inputs. The efficient sorting
methods run in O(n log n), which sits between linear and quadratic.

Complexity analysis lets you compare algorithms without running them and without
worrying about the speed of a particular computer. When someone says one algorithm
scales better than another, they mean that as the input grows very large, the
better algorithm's running time grows more slowly.
