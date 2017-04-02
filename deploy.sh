#!/bin/sh
aws s3 cp --recursive src s3://hmm.jp/ --acl public-read
aws cloudfront create-invalidation --distribution-id E2ZD5FW4GYKSQ7 --paths '/'
