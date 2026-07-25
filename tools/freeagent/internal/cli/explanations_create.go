package cli

import (
	"github.com/crossing/toolbox/tools/freeagent/internal/freeagent"

	"github.com/spf13/cobra"
)

var (
	expTransaction string
	expBankAccount string
	expDatedOn     string
	expGrossValue  string
	expCategory    string
	expDescription string
)

// explanationsCreateCmd represents the create command
var explanationsCreateCmd = &cobra.Command{
	Use:   "create",
	Short: "Create a bank transaction explanation",
	Long:  "Explain a bank transaction by assigning it to a category and providing details.",
	RunE: func(cmd *cobra.Command, args []string) error {
		explanation := freeagent.BankTransactionExplanation{
			BankTransaction: expTransaction,
			BankAccount:     expBankAccount,
			DatedOn:         expDatedOn,
			GrossValue:      expGrossValue,
			Category:        expCategory,
			Description:     expDescription,
		}

		newExplanation, err := apiClient.CreateBankTransactionExplanation(explanation)
		if err != nil {
			return err
		}

		return formatOutput(newExplanation)
	},
}

func init() {
	explanationsCmd.AddCommand(explanationsCreateCmd)

	explanationsCreateCmd.Flags().StringVar(&expTransaction, "transaction", "", "Bank transaction URI")
	explanationsCreateCmd.Flags().StringVar(&expBankAccount, "bank-account", "", "Bank account URI")
	explanationsCreateCmd.Flags().StringVar(&expDatedOn, "date", "", "Explanation date (YYYY-MM-DD)")
	explanationsCreateCmd.Flags().StringVar(&expGrossValue, "value", "", "Gross value")
	explanationsCreateCmd.Flags().StringVar(&expCategory, "category", "", "Category URI")
	explanationsCreateCmd.Flags().StringVar(&expDescription, "description", "", "Description")

	_ = explanationsCreateCmd.MarkFlagRequired("date")
	_ = explanationsCreateCmd.MarkFlagRequired("value")
	_ = explanationsCreateCmd.MarkFlagRequired("category")
}
