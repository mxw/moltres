#!/bin/bash

cd "$( dirname "${BASH_SOURCE[0]}" )"

npx ts-node-cwd src/moltres.ts

while [ $? -ne 0 ]; do
  npx ts-node-cwd src/moltres.ts
done
