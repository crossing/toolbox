package cli

import (
	"github.com/spf13/cobra"
)

// listCmd represents the list command
var listCmd = &cobra.Command{
	Use:   "list",
	Short: "List all bills",
	Long:  "Fetch and display all bills. Outputs JSON by default.",
	RunE: func(cmd *cobra.Command, args []string) error {
		bills, err := apiClient.ListBills()
		if err != nil {
			return err
		}

		return formatOutput(bills)
	},
}

func init() {
	billsCmd.AddCommand(listCmd)
}
