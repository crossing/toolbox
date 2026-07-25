package cli

import (
	"github.com/spf13/cobra"
)

var billsCmd = &cobra.Command{
	Use:   "bills",
	Short: "Manage bills in FreeAgent",
	Long:  "Commands to list, create, and manage bills and their attachments.",
}

func init() {
	rootCmd.AddCommand(billsCmd)
}
