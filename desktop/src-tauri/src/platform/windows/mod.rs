//! Every Win32 call and `unsafe` block in the shell lives in this tree (spec §1).

pub mod activity;
pub mod capture;
pub mod job;
pub mod power;
pub mod secure_key;
pub mod startup;
