#!/bin/bash

node moltres.js

while [ $? -ne 0 ]; do
  node moltres.js
done
