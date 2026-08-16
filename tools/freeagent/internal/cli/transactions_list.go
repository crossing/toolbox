package cli

import (
	"github.com/spf13/cobra"
)

var (
	bankAccount string
	txView      string
	txFromDate  string
)

// transactionsListCmd represents the list command
var transactionsListCmd = &cobra.Command{
	Use:   "list",
	Short: "List bank transactions",
	Long:  "List bank transactions for a specific bank account. Useful for finding transactions that need explanations.",
	RunE: func(cmd *cobra.Command, args []string) error {
		transactions, err := apiClient.ListBankTransactions(bankAccount, txView, txFromDate)
		if err != nil {
			return err
		}

		return formatOutput(transactions)
	},
}

var txURL string

var transactionsGetCmd = &cobra.Command{
	Use:   "get",
	Short: "Show one bank transaction with its explanations",
	RunE: func(cmd *cobra.Command, args []string) error {
		tx, err := apiClient.GetJSON(txURL)
		if err != nil {
			return err
		}

		return formatOutput(tx)
	},
}

func init() {
	transactionsCmd.AddCommand(transactionsListCmd)
	transactionsListCmd.Flags().StringVar(&bankAccount, "bank-account", "", "Bank account URI")
	transactionsListCmd.Flags().StringVar(&txView, "view", "", "Filter: unexplained, marked_for_review, manual, imported")
	transactionsListCmd.Flags().StringVar(&txFromDate, "from", "", "Only transactions dated on or after this date (YYYY-MM-DD)")

	transactionsCmd.AddCommand(transactionsGetCmd)
	transactionsGetCmd.Flags().StringVar(&txURL, "url", "", "Bank transaction URI")
	_ = transactionsGetCmd.MarkFlagRequired("url")
}
