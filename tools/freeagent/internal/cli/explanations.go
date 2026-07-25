package cli

import (
	"github.com/spf13/cobra"
)

var explanationsCmd = &cobra.Command{
	Use:   "explanations",
	Short: "Manage bank transaction explanations",
	Long:  "Commands to create and manage explanations for bank transactions, including attaching documents for reconciliation.",
}

func init() {
	rootCmd.AddCommand(explanationsCmd)
}
