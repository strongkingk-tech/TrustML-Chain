# Gas report

Measured on Hardhat's in-process local chain, Solidity 0.8.24, optimizer on (200 runs).

| Operation | Gas used | Note |
| --- | ---: | --- |
| Deploy contract | 440,373 | one time |
| register (stage 1, first record in contract) | 93,882 | first write also sets recordCount from 0 to 1 |
| register (stage 2) | 76,782 |  |
| register (stage 3) | 76,782 |  |
| register (58-char run id) | 77,749 | longer id costs a little more in calldata and event data |
| register rejected: duplicate record | 26,211 | gas still charged on revert |
| register rejected: not the registrar | 24,340 | gas still charged on revert |
| getRecord (read, existing record) | 27,397 | as a transaction, includes 21,000 base; off-chain eth_call is free |
| getRecord (read, no record) | 27,397 | as a transaction, includes 21,000 base; off-chain eth_call is free |
| isRegistered (read) | 25,034 | as a transaction, includes 21,000 base; off-chain eth_call is free |
| Register all 3 stages of one run (total) | 247,422 | stage 1 here pays the first-write counter cost |
