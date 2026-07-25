package cli

import (
	"github.com/spf13/cobra"
)

var bankAccount string

// transactionsListCmd represents the list command
var transactionsListCmd = &cobra.Command{
	Use:   "list",
	Short: "List bank transactions",
	Long:  "List bank transactions for a specific bank account. Useful for finding transactions that need explanations.",
	RunE: func(cmd *cobra.Command, args []string) error {
		transactions, err := apiClient.ListBankTransactions(bankAccount)
		if err != nil {
			return err
		}

		return formatOutput(transactions)
	},
}

func init() {
	transactionsCmd.AddCommand(transactionsListCmd)
	transactionsListCmd.Flags().StringVar(&bankAccount, "bank-account", "", "Bank account URI")
}
