package main

import (
	"flag"
	"kindlespouse/companion/localidentity"
	"os"
)

func main() {
	directory := flag.String("directory", "", "local identity directory")
	flag.Parse()
	if *directory == "" || localidentity.Create(*directory) != nil {
		os.Exit(1)
	}
}
