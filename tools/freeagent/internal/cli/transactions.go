package cli

import (
	"github.com/spf13/cobra"
)

var transactionsCmd = &cobra.Command{
	Use:   "transactions",
	Short: "Manage bank transactions",
	Long:  "Commands to list and view bank transactions that need explanation.",
}

func init() {
	rootCmd.AddCommand(transactionsCmd)
}
