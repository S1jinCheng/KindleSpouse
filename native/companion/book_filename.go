package main

import "strings"

func readableBookFilename(filename string) bool {
	lower := strings.ToLower(filename)
	for _, extension := range readableBookFormats {
		if strings.HasSuffix(lower, "."+extension) {
			return true
		}
	}
	return false
}
